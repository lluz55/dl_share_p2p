package main

import (
	"strings"
	"time"
)

// Config holds all security limits and timeout configurations.
type Config struct {
	Port               string
	AllowedOrigins     []string
	HandshakeTimeout   time.Duration
	PingInterval       time.Duration
	PongTimeout        time.Duration
	WriteTimeout       time.Duration
	MaxMessageSize     int64
	MaxGlobalConns     int
	MaxIPConns         int
	MaxGlobalRooms     int
	MaxIPRooms         int
	RoomTTL            time.Duration
	ConnRateLimitRate  float64 // connections per second
	ConnRateLimitBurst int
	MsgRateLimitRate   float64 // messages per second per connection
	MsgRateLimitBurst  int
}

// DefaultConfig returns the standard production/security defaults.
func DefaultConfig() Config {
	return Config{
		Port:               "8080",
		AllowedOrigins:     nil, // If nil, defaults to localhost for development
		HandshakeTimeout:   10 * time.Second,
		PingInterval:       30 * time.Second,
		PongTimeout:        40 * time.Second, // Must be greater than PingInterval
		WriteTimeout:       5 * time.Second,
		MaxMessageSize:     8192, // 8KB (SDPs are typically 2-4KB)
		MaxGlobalConns:     1000,
		MaxIPConns:         10,
		MaxGlobalRooms:     500,
		MaxIPRooms:         5,
		RoomTTL:            30 * time.Minute,
		ConnRateLimitRate:  2.0, // 2 connections per second per IP
		ConnRateLimitBurst: 10,
		MsgRateLimitRate:   5.0, // 5 signaling messages per second per connection
		MsgRateLimitBurst:  10,
	}
}

// ParseOrigins parses a comma-separated list of origins.
func (c *Config) ParseOrigins(originsStr string) {
	if originsStr == "" {
		c.AllowedOrigins = nil
		return
	}
	parts := strings.Split(originsStr, ",")
	for _, p := range parts {
		c.AllowedOrigins = append(c.AllowedOrigins, strings.TrimSpace(p))
	}
}
