package router

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/Infinitefft/Eterion/services/api/internal/config"
	"github.com/Infinitefft/Eterion/services/api/internal/middleware"
	"github.com/Infinitefft/Eterion/services/api/internal/modules/auth"
	"github.com/Infinitefft/Eterion/services/api/internal/shared/response"
	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func New(cfg config.Config, db *gorm.DB, logger *slog.Logger) (*gin.Engine, error) {
	if strings.EqualFold(cfg.AppEnv, "production") {
		gin.SetMode(gin.ReleaseMode)
	}

	engine := gin.New()
	if err := engine.SetTrustedProxies(nil); err != nil {
		return nil, fmt.Errorf("configure trusted proxies: %w", err)
	}
	engine.Use(
		middleware.RequestIDMiddleware(),
		middleware.Logging(logger),
		middleware.Recovery(logger),
		cors.New(cors.Config{
			AllowOrigins:     cfg.AllowedOrigins,
			AllowMethods:     []string{http.MethodGet, http.MethodPost, http.MethodOptions},
			AllowHeaders:     []string{"Accept", "Authorization", "Content-Type", "Origin"},
			ExposeHeaders:    []string{"X-Request-ID"},
			AllowCredentials: true,
			MaxAge:           12 * time.Hour,
		}),
	)

	sqlDB, err := db.DB()
	if err != nil {
		return nil, fmt.Errorf("get health check connection: %w", err)
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
		return nil, fmt.Errorf("initialize auth service: %w", err)
	}
	authHandler, err := auth.NewHandler(authService, cfg, logger)
	if err != nil {
		return nil, fmt.Errorf("initialize auth handler: %w", err)
	}
	authHandler.RegisterRoutes(engine.Group("/api"))

	return engine, nil
}

func contextWithTimeout(c *gin.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(c.Request.Context(), timeout)
}
