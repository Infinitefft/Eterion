package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

const minimumJWTSecretLength = 32

type Config struct {
	AppEnv              string
	HTTPAddr            string
	DatabaseURL         string
	DBMaxOpenConns      int
	DBMaxIdleConns      int
	DBConnMaxLifetime   time.Duration
	JWTAccessSecret     string
	JWTIssuer           string
	JWTAudience         string
	AccessTokenTTL      time.Duration
	RefreshTokenTTL     time.Duration
	RefreshCookieName   string
	RefreshCookieSecure bool
	AllowedOrigins      []string
}

func Load() (Config, error) {
	if err := godotenv.Load(); err != nil && !errors.Is(err, os.ErrNotExist) {
		return Config{}, fmt.Errorf("load .env: %w", err)
	}

	cfg := Config{
		AppEnv:            envOrDefault("APP_ENV", "development"),
		HTTPAddr:          envOrDefault("HTTP_ADDR", ":8080"),
		DatabaseURL:       strings.TrimSpace(os.Getenv("DATABASE_URL")),
		JWTAccessSecret:   os.Getenv("JWT_ACCESS_SECRET"),
		JWTIssuer:         envOrDefault("JWT_ISSUER", "eterion-api"),
		JWTAudience:       envOrDefault("JWT_AUDIENCE", "eterion-web"),
		RefreshCookieName: envOrDefault("REFRESH_COOKIE_NAME", "eterion_rt"),
		AllowedOrigins:    splitCSV(envOrDefault("CORS_ALLOWED_ORIGINS", "http://localhost:5173")),
	}

	var err error
	if cfg.DBMaxOpenConns, err = positiveIntEnv("DB_MAX_OPEN_CONNS", 20); err != nil {
		return Config{}, err
	}
	if cfg.DBMaxIdleConns, err = nonNegativeIntEnv("DB_MAX_IDLE_CONNS", 5); err != nil {
		return Config{}, err
	}
	if cfg.DBConnMaxLifetime, err = positiveDurationEnv("DB_CONN_MAX_LIFETIME", time.Hour); err != nil {
		return Config{}, err
	}
	if cfg.AccessTokenTTL, err = positiveDurationEnv("ACCESS_TOKEN_TTL", 15*time.Minute); err != nil {
		return Config{}, err
	}
	if cfg.RefreshTokenTTL, err = positiveDurationEnv("REFRESH_TOKEN_TTL", 30*24*time.Hour); err != nil {
		return Config{}, err
	}
	if cfg.RefreshCookieSecure, err = boolEnv("REFRESH_COOKIE_SECURE", false); err != nil {
		return Config{}, err
	}

	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	if c.DatabaseURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	if len(c.JWTAccessSecret) < minimumJWTSecretLength {
		return fmt.Errorf("JWT_ACCESS_SECRET must be at least %d characters", minimumJWTSecretLength)
	}
	if len(c.AllowedOrigins) == 0 {
		return errors.New("CORS_ALLOWED_ORIGINS must contain at least one origin")
	}
	for _, origin := range c.AllowedOrigins {
		if origin == "*" {
			return errors.New("CORS_ALLOWED_ORIGINS cannot contain '*' when credentials are enabled")
		}
	}
	if strings.EqualFold(c.AppEnv, "production") && !c.RefreshCookieSecure {
		return errors.New("REFRESH_COOKIE_SECURE must be true in production")
	}
	return nil
}

func (c Config) IsAllowedOrigin(origin string) bool {
	for _, allowed := range c.AllowedOrigins {
		if origin == allowed {
			return true
		}
	}
	return false
}

func envOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func splitCSV(value string) []string {
	items := strings.Split(value, ",")
	result := make([]string, 0, len(items))
	for _, item := range items {
		if item = strings.TrimSpace(item); item != "" {
			result = append(result, item)
		}
	}
	return result
}

func positiveDurationEnv(key string, fallback time.Duration) (time.Duration, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback, nil
	}
	duration, err := time.ParseDuration(value)
	if err != nil || duration <= 0 {
		return 0, fmt.Errorf("%s must be a positive duration", key)
	}
	return duration, nil
}

func positiveIntEnv(key string, fallback int) (int, error) {
	value, err := nonNegativeIntEnv(key, fallback)
	if err != nil {
		return 0, err
	}
	if value == 0 {
		return 0, fmt.Errorf("%s must be greater than zero", key)
	}
	return value, nil
}

func nonNegativeIntEnv(key string, fallback int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 {
		return 0, fmt.Errorf("%s must be a non-negative integer", key)
	}
	return value, nil
}

func boolEnv(key string, fallback bool) (bool, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("%s must be a boolean", key)
	}
	return value, nil
}
