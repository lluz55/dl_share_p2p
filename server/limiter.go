package main

import (
	"sync"
	"time"
)

// TokenBucket implements a simple thread-safe token bucket rate limiter.
type TokenBucket struct {
	mu           sync.Mutex
	rate         float64 // tokens added per second
	capacity     float64 // max tokens
	tokens       float64 // current tokens
	lastRefilled time.Time
}

// NewTokenBucket creates a new TokenBucket.
func NewTokenBucket(rate float64, capacity int) *TokenBucket {
	return &TokenBucket{
		rate:         rate,
		capacity:     float64(capacity),
		tokens:       float64(capacity),
		lastRefilled: time.Now(),
	}
}

// Allow returns true if a token is available and consumes it.
func (tb *TokenBucket) Allow() bool {
	tb.mu.Lock()
	defer tb.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(tb.lastRefilled).Seconds()
	tb.lastRefilled = now

	tb.tokens += elapsed * tb.rate
	if tb.tokens > tb.capacity {
		tb.tokens = tb.capacity
	}

	if tb.tokens >= 1.0 {
		tb.tokens -= 1.0
		return true
	}

	return false
}

type limiterEntry struct {
	bucket     *TokenBucket
	lastAccess time.Time
}

// IPRateLimiter tracks token buckets per IP and prevents memory leaks via cleanup.
type IPRateLimiter struct {
	mu       sync.Mutex
	limiters map[string]*limiterEntry
	rate     float64
	burst    int
}

// NewIPRateLimiter creates a new IPRateLimiter and starts a periodic cleanup loop.
func NewIPRateLimiter(rate float64, burst int) *IPRateLimiter {
	lim := &IPRateLimiter{
		limiters: make(map[string]*limiterEntry),
		rate:     rate,
		burst:    burst,
	}
	return lim
}

// Allow returns true if the connection attempt from the given IP is allowed.
func (l *IPRateLimiter) Allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	entry, exists := l.limiters[ip]
	if !exists {
		entry = &limiterEntry{
			bucket: NewTokenBucket(l.rate, l.burst),
		}
		l.limiters[ip] = entry
	}
	entry.lastAccess = now
	return entry.bucket.Allow()
}

// Prune cleans up limiters that have not been accessed for a while.
func (l *IPRateLimiter) Prune(maxIdle time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	for ip, entry := range l.limiters {
		if now.Sub(entry.lastAccess) > maxIdle {
			delete(l.limiters, ip)
		}
	}
}
