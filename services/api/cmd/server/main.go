package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Infinitefft/Eterion/services/api/internal/config"
	"github.com/Infinitefft/Eterion/services/api/internal/router"
	"github.com/Infinitefft/Eterion/services/api/internal/shared/database"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := database.Open(rootCtx, cfg)
	if err != nil {
		logger.Error("database initialization failed", "error", err)
		os.Exit(1)
	}
	sqlDB, err := db.DB()
	if err != nil {
		logger.Error("database connection pool unavailable", "error", err)
		os.Exit(1)
	}
	defer func() {
		if err := sqlDB.Close(); err != nil {
			logger.Error("database close failed", "error", err)
		}
	}()

	engine, err := router.New(cfg, db, logger)
	if err != nil {
		logger.Error("router initialization failed", "error", err)
		os.Exit(1)
	}
	server := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           engine,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("API server started", "address", cfg.HTTPAddr, "environment", cfg.AppEnv)
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case <-rootCtx.Done():
		logger.Info("shutdown requested")
	case err := <-serverErrors:
		if err != nil && err != http.ErrServerClosed {
			logger.Error("API server stopped unexpectedly", "error", err)
			os.Exit(1)
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
		os.Exit(1)
	}
	logger.Info("API server stopped")
}
