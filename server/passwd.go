package main

import (
	"flag"
	"fmt"
	"os"
	"time"
)

// RunPasswdCLI handles the "passwd" subcommand family.
// args is os.Args[2:] (everything after "passwd").
func RunPasswdCLI(storePath string, args []string) {
	if len(args) == 0 {
		passwdUsage()
		os.Exit(1)
	}
	switch args[0] {
	case "generate":
		runGenerate(storePath, args[1:])
	case "invalidate":
		runInvalidate(storePath, args[1:])
	case "list":
		runList(storePath)
	default:
		fmt.Fprintf(os.Stderr, "unknown passwd command: %s\n", args[0])
		passwdUsage()
		os.Exit(1)
	}
}

func passwdUsage() {
	fmt.Fprintln(os.Stderr, "Usage:")
	fmt.Fprintln(os.Stderr, "  passwd generate [--one-time] [--expires DURATION]")
	fmt.Fprintln(os.Stderr, "  passwd invalidate <id>")
	fmt.Fprintln(os.Stderr, "  passwd list")
}

func runGenerate(storePath string, args []string) {
	fs := flag.NewFlagSet("generate", flag.ExitOnError)
	oneTime := fs.Bool("one-time", false, "invalidate after first use")
	expires := fs.String("expires", "", "password lifetime, e.g. 2h or 30m (default: never)")
	_ = fs.Parse(args)

	var expiresAt *time.Time
	if *expires != "" {
		d, err := time.ParseDuration(*expires)
		if err != nil {
			fmt.Fprintf(os.Stderr, "invalid --expires value: %v\n", err)
			os.Exit(1)
		}
		t := time.Now().Add(d)
		expiresAt = &t
	}

	store, err := NewPasswordStore(storePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to open store: %v\n", err)
		os.Exit(1)
	}

	id, err := generateID()
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to generate ID: %v\n", err)
		os.Exit(1)
	}
	secret, err := generateSecret(12)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to generate secret: %v\n", err)
		os.Exit(1)
	}
	salt, err := generateSecret(8)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to generate salt: %v\n", err)
		os.Exit(1)
	}

	rec := PasswordRecord{
		ID:        id,
		Salt:      salt,
		Hash:      hashSecret(secret, salt),
		OneTime:   *oneTime,
		ExpiresAt: expiresAt,
		CreatedAt: time.Now(),
	}
	if err := store.Add(rec); err != nil {
		fmt.Fprintf(os.Stderr, "failed to save: %v\n", err)
		os.Exit(1)
	}

	mode := "multi-use"
	if rec.OneTime {
		mode = "one-time"
	}
	exp := "never"
	if rec.ExpiresAt != nil {
		exp = rec.ExpiresAt.Format(time.RFC3339)
	}
	fmt.Printf("ID:      %s\nSecret:  %s\nMode:    %s\nExpires: %s\n", rec.ID, secret, mode, exp)
}

func runInvalidate(storePath string, args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: passwd invalidate <id>")
		os.Exit(1)
	}
	id := args[0]

	store, err := NewPasswordStore(storePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to open store: %v\n", err)
		os.Exit(1)
	}

	found, err := store.Remove(id)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to save: %v\n", err)
		os.Exit(1)
	}
	if !found {
		fmt.Fprintf(os.Stderr, "no password with ID %s\n", id)
		os.Exit(1)
	}
	fmt.Printf("invalidated %s\n", id)
}

func runList(storePath string) {
	store, err := NewPasswordStore(storePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to open store: %v\n", err)
		os.Exit(1)
	}

	records := store.List()
	if len(records) == 0 {
		fmt.Println("(no passwords)")
		return
	}
	fmt.Printf("%-10s  %-8s  %s\n", "ID", "MODE", "EXPIRES")
	for _, r := range records {
		mode := "multi"
		if r.OneTime {
			mode = "one-time"
		}
		exp := "never"
		if r.ExpiresAt != nil {
			exp = r.ExpiresAt.Format("2006-01-02 15:04 MST")
		}
		fmt.Printf("%-10s  %-8s  %s\n", r.ID, mode, exp)
	}
}
