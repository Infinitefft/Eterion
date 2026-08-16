// 负责集中读取和校验 Go API 的数据库、认证、Chat 与 Agent 环境变量。
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

const defaultSystemPrompt = "你是 Eterion 的 AI 助手。请准确、清晰地回答用户问题。"

// ModelConfig 描述一个可以由前端选择的 OpenAI 兼容文本模型。
// APIKey 只在服务端使用，不会通过模型列表或 IM 协议返回给浏览器。
type ModelConfig struct {
	ID          string
	DisplayName string
	Provider    string
	APIKey      string
	BaseURL     string
	Model       string
}

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
	ModelAPIKey         string
	ModelBaseURL        string
	ModelName           string
	DefaultModelID      string
	Models              []ModelConfig
	SystemPrompt        string
	ModelTimeout        time.Duration
	AgentRunTimeout     time.Duration
	WebSocketTicketTTL  time.Duration
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
		ModelAPIKey:       strings.TrimSpace(os.Getenv("MODEL_API_KEY")),
		ModelBaseURL:      strings.TrimSpace(os.Getenv("MODEL_BASE_URL")),
		ModelName:         strings.TrimSpace(os.Getenv("MODEL_NAME")),
		SystemPrompt:      envOrDefault("SYSTEM_PROMPT", defaultSystemPrompt),
	}
	cfg.Models = loadModelConfigs()
	cfg.DefaultModelID = strings.TrimSpace(os.Getenv("DEFAULT_MODEL_ID"))
	if cfg.DefaultModelID == "" && len(cfg.Models) > 0 {
		cfg.DefaultModelID = cfg.Models[0].ID
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
	if cfg.ModelTimeout, err = positiveDurationEnv("MODEL_TIMEOUT", 2*time.Minute); err != nil {
		return Config{}, err
	}
	if cfg.AgentRunTimeout, err = positiveDurationEnv("AGENT_RUN_TIMEOUT", 10*time.Minute); err != nil {
		return Config{}, err
	}
	if cfg.WebSocketTicketTTL, err = positiveDurationEnv("WS_TICKET_TTL", 45*time.Second); err != nil {
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
	// 保留旧的单模型环境变量作为兼容入口；配置了新的模型注册表后，
	// DEFAULT_MODEL_ID 必须指向其中一个完整配置的模型。
	if len(c.Models) == 0 {
		if strings.TrimSpace(c.ModelAPIKey) == "" {
			return errors.New("at least one model API key is required")
		}
		if strings.TrimSpace(c.ModelName) == "" {
			return errors.New("at least one model name is required")
		}
		return nil
	}

	seen := make(map[string]struct{}, len(c.Models))
	defaultFound := false
	for _, model := range c.Models {
		id := strings.TrimSpace(model.ID)
		if id == "" {
			return errors.New("model ID is required")
		}
		if _, exists := seen[id]; exists {
			return fmt.Errorf("duplicate model ID: %s", id)
		}
		seen[id] = struct{}{}
		if strings.TrimSpace(model.APIKey) == "" {
			return fmt.Errorf("%s API key is required", id)
		}
		if strings.TrimSpace(model.BaseURL) == "" {
			return fmt.Errorf("%s base URL is required", id)
		}
		if strings.TrimSpace(model.Model) == "" {
			return fmt.Errorf("%s provider model name is required", id)
		}
		if id == strings.TrimSpace(c.DefaultModelID) {
			defaultFound = true
		}
	}
	if !defaultFound {
		return fmt.Errorf("DEFAULT_MODEL_ID %q is not configured", c.DefaultModelID)
	}
	return nil
}

func loadModelConfigs() []ModelConfig {
	definitions := []struct {
		id          string
		displayName string
		provider    string
		prefix      string
		baseURL     string
	}{
		{
			id:          "doubao",
			displayName: "豆包",
			provider:    "doubao",
			prefix:      "DOUBAO",
			baseURL:     "https://ark.cn-beijing.volces.com/api/v3",
		},
		{
			id:          "deepseek",
			displayName: "DeepSeek",
			provider:    "deepseek",
			prefix:      "DEEPSEEK",
			baseURL:     "https://api.deepseek.com",
		},
		{
			id:          "minimax",
			displayName: "MiniMax",
			provider:    "minimax",
			prefix:      "MINIMAX",
			baseURL:     "https://api.minimaxi.com/v1",
		},
	}

	models := make([]ModelConfig, 0, len(definitions))
	for _, definition := range definitions {
		apiKey := strings.TrimSpace(os.Getenv(definition.prefix + "_API_KEY"))
		providerModel := strings.TrimSpace(os.Getenv(definition.prefix + "_MODEL"))
		// 完全没有填写时视为未启用；只填写一部分时保留配置，交给
		// Validate 给出明确错误，避免服务悄悄隐藏拼写错误的模型。
		if apiKey == "" && providerModel == "" {
			continue
		}
		models = append(models, ModelConfig{
			ID:          definition.id,
			DisplayName: definition.displayName,
			Provider:    definition.provider,
			APIKey:      apiKey,
			BaseURL: envOrDefault(
				definition.prefix+"_BASE_URL",
				definition.baseURL,
			),
			Model: providerModel,
		})
	}
	return models
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
