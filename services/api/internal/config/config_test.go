package config

import (
	"strings"
	"testing"
	"time"
)

func validConfig() Config {
	return Config{
		AppEnv:              "development",
		HTTPAddr:            ":8080",
		DatabaseURL:         "postgres://localhost/eterion",
		DBMaxOpenConns:      20,
		DBMaxIdleConns:      5,
		DBConnMaxLifetime:   time.Hour,
		JWTAccessSecret:     strings.Repeat("a", 32),
		JWTIssuer:           "eterion-api",
		JWTAudience:         "eterion-web",
		AccessTokenTTL:      15 * time.Minute,
		RefreshTokenTTL:     30 * 24 * time.Hour,
		RefreshCookieName:   "eterion_rt",
		RefreshCookieSecure: false,
		AllowedOrigins:      []string{"http://localhost:5173"},
	}
}

func TestConfigValidation(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{"missing database URL", func(cfg *Config) { cfg.DatabaseURL = "" }},
		{"weak JWT secret", func(cfg *Config) { cfg.JWTAccessSecret = "too-short" }},
		{"wildcard credential origin", func(cfg *Config) { cfg.AllowedOrigins = []string{"*"} }},
		{"insecure production cookie", func(cfg *Config) {
			cfg.AppEnv = "production"
			cfg.RefreshCookieSecure = false
		}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := validConfig()
			test.mutate(&cfg)
			if err := cfg.Validate(); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestValidProductionConfig(t *testing.T) {
	cfg := validConfig()
	cfg.AppEnv = "production"
	cfg.RefreshCookieSecure = true
	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected valid config, got %v", err)
	}
}
