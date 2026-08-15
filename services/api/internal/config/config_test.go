package config

import (
	"strings"
	"testing"
)

func TestValidateRequiresModelConfiguration(t *testing.T) {
	tests := []struct {
		name      string
		configure func(*Config)
		want      string
	}{
		{
			name: "missing API key",
			configure: func(config *Config) {
				config.ModelAPIKey = ""
			},
			want: "MODEL_API_KEY is required",
		},
		{
			name: "missing model name",
			configure: func(config *Config) {
				config.ModelName = ""
			},
			want: "MODEL_NAME is required",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			config := validConfig()
			test.configure(&config)
			err := config.Validate()
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("expected %q, got %v", test.want, err)
			}
		})
	}
}

func TestValidateAcceptsEinoModelConfiguration(t *testing.T) {
	if err := validConfig().Validate(); err != nil {
		t.Fatalf("validate config: %v", err)
	}
}

func validConfig() Config {
	return Config{
		AppEnv:          "development",
		DatabaseURL:     "postgres://example",
		JWTAccessSecret: strings.Repeat("x", minimumJWTSecretLength),
		AllowedOrigins:  []string{"http://localhost:5173"},
		ModelAPIKey:     "test-model-key",
		ModelName:       "test-model",
	}
}
