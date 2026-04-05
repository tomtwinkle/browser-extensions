// llama_bridge.cpp – llama.cpp C++ 実装ブリッジ
//
// CGo は .cpp ファイルを C++ コンパイラで自動コンパイルする。
// extern "C" 宣言により C 側から呼び出し可能。

#include "llama_bridge.h"
#include "llama.h"

#include <cstring>
#include <cstdio>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// 内部型
// ---------------------------------------------------------------------------

struct llama_bridge_model_s {
    llama_model*   model;
    llama_vocab*   vocab;  // llama_model_get_vocab() の結果をキャッシュ
};

// ---------------------------------------------------------------------------
// バックエンド初期化
// ---------------------------------------------------------------------------

void llama_bridge_backend_init(void) {
    llama_backend_init();
}

void llama_bridge_backend_free(void) {
    llama_backend_free();
}

// ---------------------------------------------------------------------------
// モデルのロード / 解放
// ---------------------------------------------------------------------------

llama_bridge_model llama_bridge_load_model(const char* model_path, int n_gpu_layers) {
    llama_model_params mparams = llama_model_default_params();
    mparams.n_gpu_layers = n_gpu_layers;

    llama_model* model = llama_model_load_from_file(model_path, mparams);
    if (!model) return nullptr;

    auto* h     = new llama_bridge_model_s;
    h->model    = model;
    h->vocab    = const_cast<llama_vocab*>(llama_model_get_vocab(model));
    return h;
}

void llama_bridge_free_model(llama_bridge_model handle) {
    if (!handle) return;
    llama_model_free(handle->model);
    delete handle;
}

// ---------------------------------------------------------------------------
// テキスト生成
// ---------------------------------------------------------------------------

int llama_bridge_generate(
    llama_bridge_model handle,
    const char*  prompt,
    int          max_tokens,
    float        temperature,
    char*        output_buf,
    int          output_buf_size,
    char*        error_buf,
    int          error_buf_size
) {
    if (!handle) {
        snprintf(error_buf, error_buf_size, "モデルが初期化されていません");
        return -1;
    }

    // コンテキスト作成
    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx     = 2048;
    cparams.n_threads = 4;
    cparams.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_ENABLED; // FlashAttention: 高速化

    llama_context* ctx = llama_init_from_model(handle->model, cparams);
    if (!ctx) {
        snprintf(error_buf, error_buf_size, "llama context の作成に失敗");
        return -2;
    }

    // トークナイズ
    std::vector<llama_token> tokens(2048);
    int n_tok = llama_tokenize(
        handle->vocab, prompt, (int)strlen(prompt),
        tokens.data(), (int)tokens.size(),
        /* add_special= */ true,
        /* parse_special= */ true
    );
    if (n_tok < 0) {
        snprintf(error_buf, error_buf_size, "トークナイズに失敗 (バッファ不足?)");
        llama_free(ctx);
        return -3;
    }
    tokens.resize(n_tok);

    // プリフィル (prompt を decode)
    {
        llama_batch batch = llama_batch_get_one(tokens.data(), (int)tokens.size());
        if (llama_decode(ctx, batch) != 0) {
            snprintf(error_buf, error_buf_size, "llama_decode (prefill) に失敗");
            llama_free(ctx);
            return -4;
        }
    }

    // サンプラー設定
    llama_sampler_chain_params sparams = llama_sampler_chain_default_params();
    llama_sampler* smpl = llama_sampler_chain_init(sparams);
    llama_sampler_chain_add(smpl, llama_sampler_init_temp(temperature));
    llama_sampler_chain_add(smpl, llama_sampler_init_greedy());

    // 生成ループ
    std::string result;
    char piece[256];

    for (int i = 0; i < max_tokens; i++) {
        llama_token tok = llama_sampler_sample(smpl, ctx, -1);

        if (llama_vocab_is_eog(handle->vocab, tok)) break;

        int n = llama_token_to_piece(handle->vocab, tok, piece, (int)sizeof(piece), 0, true);
        if (n > 0) result.append(piece, n);

        llama_batch next = llama_batch_get_one(&tok, 1);
        if (llama_decode(ctx, next) != 0) break;
    }

    // 結果をコピー
    strncpy(output_buf, result.c_str(), output_buf_size - 1);
    output_buf[output_buf_size - 1] = '\0';

    // クリーンアップ
    llama_sampler_free(smpl);
    llama_free(ctx);

    return 0;
}
