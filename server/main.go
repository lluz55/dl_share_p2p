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

	relayManager := NewRelayManager(logger)
	hub := NewHub(logger, config, relayManager)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Start the room activity reaper
	hub.StartReaper(ctx)
	defer hub.Close()

	// Configure handlers
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		serveWs(hub, w, r, logger)
	})
	mux.HandleFunc("/relay", func(w http.ResponseWriter, r *http.Request) {
		ServeRelay(relayManager, w, r, logger)
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
