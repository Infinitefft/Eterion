// 负责创建 Gin 路由，并装配认证、Chat、WebSocket 和 Eino Agent 依赖。
package router

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/Infinitefft/Eterion/services/api/internal/agent/eino"
	"github.com/Infinitefft/Eterion/services/api/internal/apidocs"
	"github.com/Infinitefft/Eterion/services/api/internal/config"
	"github.com/Infinitefft/Eterion/services/api/internal/middleware"
	"github.com/Infinitefft/Eterion/services/api/internal/modules/auth"
	"github.com/Infinitefft/Eterion/services/api/internal/modules/chat"
	"github.com/Infinitefft/Eterion/services/api/internal/shared/response"
	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// Runtime 保存需要在应用退出时主动关闭的长生命周期组件。
type Runtime struct {
	hub  *chat.Hub
	runs *chat.RunManager
}

func (r *Runtime) Close() error {
	r.hub.CloseAll("server shutting down")
	return r.runs.Close()
}

func New(
	appContext context.Context,
	cfg config.Config,
	db *gorm.DB,
	logger *slog.Logger,
) (*gin.Engine, *Runtime, error) {
	if strings.EqualFold(cfg.AppEnv, "production") {
		gin.SetMode(gin.ReleaseMode)
	}

	engine := gin.New()
	if err := engine.SetTrustedProxies(nil); err != nil {
		return nil, nil, fmt.Errorf("configure trusted proxies: %w", err)
	}
	engine.Use(
		middleware.RequestIDMiddleware(),
		middleware.Logging(logger),
		middleware.Recovery(logger),
		cors.New(cors.Config{
			AllowOrigins: cfg.AllowedOrigins,
			AllowMethods: []string{
				http.MethodGet,
				http.MethodPost,
				http.MethodPatch,
				http.MethodDelete,
				http.MethodOptions,
			},
			AllowHeaders:     []string{"Accept", "Authorization", "Content-Type", "Origin"},
			ExposeHeaders:    []string{"X-Request-ID"},
			AllowCredentials: true,
			MaxAge:           12 * time.Hour,
		}),
	)

	sqlDB, err := db.DB()
	if err != nil {
		return nil, nil, fmt.Errorf("get health check connection: %w", err)
	}
	engine.GET("/healthz", func(c *gin.Context) {
		ctx, cancel := contextWithTimeout(c, 2*time.Second)
		defer cancel()
		if err := sqlDB.PingContext(ctx); err != nil {
			logger.Error("database health check failed", "error", err)
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"error": gin.H{
					"code":        "DATABASE_UNAVAILABLE",
					"message":     "数据库暂时不可用",
					"next_action": "RETRY_LATER",
				},
				"request_id": middleware.RequestID(c),
			})
			return
		}
		response.JSON(c, http.StatusOK, gin.H{"status": "ok"})
	})

	tokenManager := auth.NewTokenManager(
		cfg.JWTAccessSecret,
		cfg.JWTIssuer,
		cfg.JWTAudience,
		cfg.AccessTokenTTL,
	)
	authService, err := auth.NewService(auth.NewRepository(db), tokenManager, cfg.RefreshTokenTTL)
	if err != nil {
		return nil, nil, fmt.Errorf("initialize auth service: %w", err)
	}
	authHandler, err := auth.NewHandler(authService, cfg, logger)
	if err != nil {
		return nil, nil, fmt.Errorf("initialize auth handler: %w", err)
	}

	chatRepository := chat.NewRepository(db)
	chatService := chat.NewService(chatRepository)
	hub := chat.NewHub(logger)
	publisher := chat.NewPublisher(hub)
	modelConfigs := make([]eino.Config, 0, len(cfg.Models))
	for _, modelConfig := range cfg.Models {
		modelConfigs = append(modelConfigs, eino.Config{
			ID:           modelConfig.ID,
			ModelName:    modelConfig.ModelName,
			Provider:     modelConfig.Provider,
			ProviderName: modelConfig.ProviderName,
			IconURL:      modelConfig.IconURL,
			APIKey:       modelConfig.APIKey,
			BaseURL:      modelConfig.BaseURL,
			Model:        modelConfig.Model,
			SystemPrompt: cfg.SystemPrompt,
			ModelTimeout: cfg.ModelTimeout,
			RunTimeout:   cfg.AgentRunTimeout,
		})
	}
	defaultModelID := cfg.DefaultModelID
	if len(modelConfigs) == 0 {
		defaultModelID = "default"
		modelConfigs = append(modelConfigs, eino.Config{
			ID:           defaultModelID,
			ModelName:    cfg.ModelName,
			Provider:     "openai-compatible",
			ProviderName: "OpenAI 兼容",
			APIKey:       cfg.ModelAPIKey,
			BaseURL:      cfg.ModelBaseURL,
			Model:        cfg.ModelName,
			SystemPrompt: cfg.SystemPrompt,
			ModelTimeout: cfg.ModelTimeout,
			RunTimeout:   cfg.AgentRunTimeout,
		})
	}
	runner, err := eino.NewRoutingRunner(
		appContext,
		modelConfigs,
		defaultModelID,
	)
	if err != nil {
		return nil, nil, fmt.Errorf("initialize agent runner: %w", err)
	}
	runManager := chat.NewRunManager(
		appContext,
		chatRepository,
		runner,
		publisher,
		logger,
	)
	commandRouter := chat.NewCommandRouter(
		chatService,
		runManager,
		publisher,
		logger,
		runner,
	)
	chatHandler := chat.NewHandler(
		chatService,
		chat.NewTicketService(cfg.WebSocketTicketTTL),
		hub,
		publisher,
		commandRouter,
		cfg,
		logger,
		runner,
	)

	api := engine.Group("/api")
	authHandler.RegisterRoutes(api)
	chatHandler.RegisterRoutes(api, authHandler.RequireAccessToken())
	apidocs.RegisterRoutes(engine, cfg.AppEnv)

	return engine, &Runtime{
		hub:  hub,
		runs: runManager,
	}, nil
}

func contextWithTimeout(c *gin.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(c.Request.Context(), timeout)
}
