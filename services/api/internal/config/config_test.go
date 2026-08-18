package config

import (
	"strings"
	"testing"
	"time"
)

func TestLoadAgentServiceConfiguration(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://localhost/eterion")
	t.Setenv("JWT_ACCESS_SECRET", strings.Repeat("a", 32))
	t.Setenv("AGENT_SERVICE_URL", "http://127.0.0.1:9001")
	t.Setenv("AGENT_CONNECT_TIMEOUT", "7s")
	t.Setenv("AGENT_RUN_TIMEOUT", "12m")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if cfg.AgentServiceURL != "http://127.0.0.1:9001" {
		t.Fatalf("unexpected Agent URL: %s", cfg.AgentServiceURL)
	}
	if cfg.AgentConnectTimeout != 7*time.Second || cfg.AgentRunTimeout != 12*time.Minute {
		t.Fatalf("unexpected Agent timeouts: %s %s", cfg.AgentConnectTimeout, cfg.AgentRunTimeout)
	}
}
