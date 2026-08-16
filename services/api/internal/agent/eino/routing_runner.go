package eino

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/Infinitefft/Eterion/services/api/internal/agent"
)

const modelNotAvailableCode = "MODEL_NOT_AVAILABLE"

// RoutingRunner 按业务侧稳定模型 ID 将一次文本 Run 路由到对应的 Eino Runner。
// 所有模型在服务启动时创建，并在并发请求之间安全复用。
type RoutingRunner struct {
	defaultModelID string
	runners        map[string]*Runner
	models         []agent.ModelInfo
}

// NewRoutingRunner 创建所有已配置模型，并校验默认模型和模型 ID 唯一性。
func NewRoutingRunner(
	ctx context.Context,
	configs []Config,
	defaultModelID string,
) (*RoutingRunner, error) {
	if len(configs) == 0 {
		return nil, errors.New("at least one model config is required")
	}

	routing := &RoutingRunner{
		defaultModelID: strings.TrimSpace(defaultModelID),
		runners:        make(map[string]*Runner, len(configs)),
		models:         make([]agent.ModelInfo, 0, len(configs)),
	}
	for _, config := range configs {
		config.ID = strings.TrimSpace(config.ID)
		if config.ID == "" {
			return nil, errors.New("model ID is required")
		}
		if _, exists := routing.runners[config.ID]; exists {
			return nil, fmt.Errorf("duplicate model ID: %s", config.ID)
		}

		runner, err := NewRunner(ctx, config)
		if err != nil {
			return nil, fmt.Errorf("initialize model %s: %w", config.ID, err)
		}
		routing.runners[config.ID] = runner
		routing.models = append(routing.models, agent.ModelInfo{
			ID:           config.ID,
			ModelName:    strings.TrimSpace(config.ModelName),
			Provider:     strings.TrimSpace(config.Provider),
			ProviderName: strings.TrimSpace(config.ProviderName),
			IconURL:      strings.TrimSpace(config.IconURL),
		})
	}

	if routing.defaultModelID == "" {
		routing.defaultModelID = routing.models[0].ID
	}
	if _, exists := routing.runners[routing.defaultModelID]; !exists {
		return nil, fmt.Errorf(
			"default model %q is not configured",
			routing.defaultModelID,
		)
	}
	sort.SliceStable(routing.models, func(left, right int) bool {
		return routing.models[left].ID < routing.models[right].ID
	})
	return routing, nil
}

func (r *RoutingRunner) Run(
	ctx context.Context,
	input agent.Input,
	handle func(agent.Event) error,
) error {
	modelID, ok := r.ResolveModelID(input.ModelID)
	if !ok {
		return &agent.Failure{
			Code:      modelNotAvailableCode,
			Message:   "所选模型不可用",
			Retryable: false,
		}
	}
	input.ModelID = modelID
	return r.runners[modelID].Run(ctx, input, handle)
}

func (r *RoutingRunner) DefaultModelID() string {
	return r.defaultModelID
}

func (r *RoutingRunner) ResolveModelID(modelID string) (string, bool) {
	modelID = strings.TrimSpace(modelID)
	if modelID == "" {
		modelID = r.defaultModelID
	}
	_, exists := r.runners[modelID]
	return modelID, exists
}

func (r *RoutingRunner) Models() []agent.ModelInfo {
	models := make([]agent.ModelInfo, len(r.models))
	copy(models, r.models)
	return models
}

func (r *RoutingRunner) Close() error {
	var closeError error
	for _, runner := range r.runners {
		closeError = errors.Join(closeError, runner.Close())
	}
	return closeError
}

var _ agent.Runner = (*RoutingRunner)(nil)
var _ agent.ModelCatalog = (*RoutingRunner)(nil)
