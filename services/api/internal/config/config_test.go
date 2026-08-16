package config

import "testing"

func TestLoadModelConfigsSeparatesPublicAndProviderModelNames(t *testing.T) {
	t.Setenv("DOUBAO_API_KEY", "doubao-key")
	t.Setenv("DOUBAO_SEED_2_1_PRO_MODEL", "doubao-seed-2-1-pro-260628")
	t.Setenv("DOUBAO_SEED_2_1_PRO_NAME", "Doubao-Seed-2.1-pro")
	t.Setenv("DOUBAO_ICON_URL", "")
	t.Setenv("DEEPSEEK_API_KEY", "deepseek-key")
	t.Setenv("DEEPSEEK_V4_PRO_MODEL", "deepseek-v4-pro")
	t.Setenv("DEEPSEEK_V4_PRO_NAME", "DeepSeek-V4-Pro")
	t.Setenv("DEEPSEEK_ICON_URL", "")
	t.Setenv("MINIMAX_API_KEY", "minimax-key")
	t.Setenv("MINIMAX_M2_7_MODEL", "MiniMax-M2.7")
	t.Setenv("MINIMAX_M2_7_NAME", "MiniMax M2.7")
	t.Setenv("MINIMAX_ICON_URL", "")

	models := loadModelConfigs()
	if len(models) != 3 {
		t.Fatalf("unexpected model count: %d", len(models))
	}

	expected := []struct {
		id            string
		modelName     string
		providerModel string
		providerName  string
		iconURL       string
	}{
		{
			id:            "doubao-seed-2-1-pro",
			modelName:     "Doubao-Seed-2.1-pro",
			providerModel: "doubao-seed-2-1-pro-260628",
			providerName:  "豆包",
			iconURL:       "/model-icons/doubao-seed-2-1-pro.png",
		},
		{
			id:            "deepseek-v4-pro",
			modelName:     "DeepSeek-V4-Pro",
			providerModel: "deepseek-v4-pro",
			providerName:  "DeepSeek",
			iconURL:       "/model-icons/deepseek-v4-pro.png",
		},
		{
			id:            "minimax-m2-7",
			modelName:     "MiniMax M2.7",
			providerModel: "MiniMax-M2.7",
			providerName:  "MiniMax",
			iconURL:       "/model-icons/minimax-m2-7.png",
		},
	}

	for index, want := range expected {
		got := models[index]
		if got.ID != want.id ||
			got.ModelName != want.modelName ||
			got.Model != want.providerModel ||
			got.ProviderName != want.providerName ||
			got.IconURL != want.iconURL {
			t.Fatalf("unexpected model at index %d: %+v", index, got)
		}
	}
}
