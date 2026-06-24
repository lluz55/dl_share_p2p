package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"os"
	"sync"
	"time"
)

// PasswordRecord is a single shared access password in the store.
type PasswordRecord struct {
	ID        string     `json:"id"`
	Salt      string     `json:"salt"`
	Hash      string     `json:"hash"`
	OneTime   bool       `json:"oneTime"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
}

type storeFile struct {
	Passwords []PasswordRecord `json:"passwords"`
}

// PasswordStore persists password records to a JSON file and is safe for
// concurrent use between the running server and CLI subcommands.
// When path is empty the store operates in-memory only (useful in tests).
type PasswordStore struct {
	mu      sync.Mutex
	path    string
	records []PasswordRecord
	modTime time.Time
}

// NewPasswordStore opens path and loads existing records.
// If the file does not yet exist, the store starts empty.
// Pass an empty path for an in-memory-only store.
func NewPasswordStore(path string) (*PasswordStore, error) {
	s := &PasswordStore{path: path}
	if path != "" {
		if err := s.loadLocked(); err != nil && !os.IsNotExist(err) {
			return nil, err
		}
	}
	return s, nil
}

func (s *PasswordStore) loadLocked() error {
	info, err := os.Stat(s.path)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(s.path)
	if err != nil {
		return err
	}
	var f storeFile
	if err := json.Unmarshal(data, &f); err != nil {
		return err
	}
	s.records = f.Passwords
	s.modTime = info.ModTime()
	return nil
}

func (s *PasswordStore) saveLocked() error {
	if s.path == "" {
		return nil
	}
	data, err := json.MarshalIndent(storeFile{Passwords: s.records}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, data, 0600)
}

// Add persists a new password record.
func (s *PasswordStore) Add(rec PasswordRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.records = append(s.records, rec)
	return s.saveLocked()
}

// Remove deletes the record with the given ID. Returns true when found.
func (s *PasswordStore) Remove(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, r := range s.records {
		if r.ID == id {
			s.records = append(s.records[:i], s.records[i+1:]...)
			return true, s.saveLocked()
		}
	}
	return false, nil
}

// List returns a snapshot of all records.
func (s *PasswordStore) List() []PasswordRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]PasswordRecord, len(s.records))
	copy(out, s.records)
	return out
}

// Consume checks whether secret matches a valid (non-expired) record.
// One-time records are removed from the store on first successful match.
func (s *PasswordStore) Consume(secret string) bool {
	if secret == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for i, r := range s.records {
		if r.ExpiresAt != nil && now.After(*r.ExpiresAt) {
			continue
		}
		expectedHash := hashSecret(secret, r.Salt)
		if subtle.ConstantTimeCompare([]byte(r.Hash), []byte(expectedHash)) == 1 {
			if r.OneTime {
				s.records = append(s.records[:i], s.records[i+1:]...)
				_ = s.saveLocked()
			}
			return true
		}
	}
	return false
}

func hashSecret(secret, salt string) string {
	h := sha256.New()
	h.Write([]byte(secret + salt))
	return hex.EncodeToString(h.Sum(nil))
}

// ReloadIfChanged re-reads the file when its mtime has advanced.
// No-op when the store is in-memory only.
func (s *PasswordStore) ReloadIfChanged() {
	if s.path == "" {
		return
	}
	info, err := os.Stat(s.path)
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !info.ModTime().After(s.modTime) {
		return
	}
	_ = s.loadLocked()
}

// Prune removes expired records and persists the change.
func (s *PasswordStore) Prune() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	n := 0
	for _, r := range s.records {
		if r.ExpiresAt == nil || now.Before(*r.ExpiresAt) {
			s.records[n] = r
			n++
		}
	}
	if n < len(s.records) {
		s.records = s.records[:n]
		_ = s.saveLocked()
	}
}

func generateID() (string, error) {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func generateSecret(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
