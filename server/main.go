package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	// Dispatch "passwd" subcommand without starting the HTTP server.
	if len(os.Args) > 1 && os.Args[1] == "passwd" {
		storePath := passwordsFilePath()
		RunPasswdCLI(storePath, os.Args[2:])
		return
	}

	// Initialize default config
	config := DefaultConfig()
	if envPort := os.Getenv("PORT"); envPort != "" {
		config.Port = envPort
	}

	// Parse flags/env overrides
	port := flag.String("port", config.Port, "port to bind the server to")
	origins := flag.String("origins", os.Getenv("ALLOWED_ORIGINS"), "comma-separated list of allowed origins")
	flag.Parse()

	config.Port = *port
	config.ParseOrigins(*origins)

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	logger.Info("p2pshare server starting")

	if len(config.AllowedOrigins) > 0 {
		logger.Info("configured allowed origins", "origins", config.AllowedOrigins)
	} else {
		logger.Warn("no ALLOWED_ORIGINS specified; defaulting to localhost/127.0.0.1 for development")
	}

	// Relay access auth: passwords are managed via the "passwd" subcommand and
	// persisted to PASSWORDS_FILE (default: passwords.json). The server reloads
	// the file automatically when it changes. Senders must log in with a shared
	// password to obtain a session token before the Go relay will broker their
	// transfer (SPEC §4.3).
	storePath := passwordsFilePath()
	store, err := NewPasswordStore(storePath)
	if err != nil {
		logger.Error("failed to open password store", "err", err, "path", storePath)
		os.Exit(1)
	}
	logger.Info("password store loaded", "path", storePath, "passwords", len(store.List()))

	tokenTTL := parseDurationEnv("RELAY_TOKEN_TTL", 1*time.Hour, logger)
	authManager := NewAuthManager(logger, store, tokenTTL)

	relayManager := NewRelayManager(logger)
	hub := NewHub(logger, config, relayManager, authManager)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Start the room activity reaper (also prunes expired passwords/tokens).
	hub.StartReaper(ctx)
	defer hub.Close()

	// Watch the password store file and reload when it changes (e.g. after
	// running "passwd generate" or "passwd invalidate" while the server is up).
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				store.ReloadIfChanged()
			case <-ctx.Done():
				return
			}
		}
	}()

	// Configure handlers
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		serveWs(hub, w, r, logger)
	})
	mux.HandleFunc("/relay", func(w http.ResponseWriter, r *http.Request) {
		ServeRelay(relayManager, config.AllowedOrigins, w, r, logger)
	})
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		ServeLogin(authManager, config, w, r, logger)
	})

	// Simple status/health check
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprintln(w, "OK")
	})

	// Listen only on 127.0.0.1 per SPEC §6.1
	addr := fmt.Sprintf("127.0.0.1:%s", config.Port)
	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		logger.Info("listening", "address", addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("server failed to start", "err", err)
			os.Exit(1)
		}
	}()

	// SIGHUP triggers an immediate store reload (bypasses the 2s poll interval).
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	go func() {
		for range hup {
			store.ReloadIfChanged()
			logger.Info("password store reloaded (SIGHUP)")
		}
	}()

	// Graceful shutdown handling
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	logger.Info("shutting down server...")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("server shutdown failed", "err", err)
	}
	logger.Info("server stopped")
}

// passwordsFilePath returns the path to the password store file.
func passwordsFilePath() string {
	if p := os.Getenv("PASSWORDS_FILE"); p != "" {
		return p
	}
	return "passwords.json"
}

// parseDurationEnv reads a time.Duration from an env var, falling back to def.
// An empty value uses def; "0" disables (returns 0); an invalid value warns.
func parseDurationEnv(name string, def time.Duration, logger *slog.Logger) time.Duration {
	raw := os.Getenv(name)
	if raw == "" {
		return def
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		logger.Warn("invalid duration env var; using default", "var", name, "value", raw, "default", def)
		return def
	}
	return d
}
