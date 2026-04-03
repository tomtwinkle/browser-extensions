// whisper_bridge.cpp – whisper.cpp C++ 実装ブリッジ

#include "whisper_bridge.h"
#include "whisper.h"

#include <cstring>
#include <cstdio>
#include <string>

whisper_context* whisper_bridge_init(const char* model_path) {
    whisper_context_params cparams = whisper_context_default_params();
    cparams.use_gpu = true; // Metal/CUDA が有効なら自動で GPU を使う
    return whisper_init_from_file_with_params(model_path, cparams);
}

void whisper_bridge_free(whisper_context* ctx) {
    if (ctx) whisper_free(ctx);
}

int whisper_bridge_transcribe(
    whisper_context* ctx,
    const float*     samples,
    int              n_samples,
    const char*      language,
    char*            output_buf,
    int              output_buf_size,
    char*            error_buf,
    int              error_buf_size
) {
    whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.n_threads        = 4;
    params.print_progress   = false;
    params.print_realtime   = false;
    params.print_timestamps = false;
    params.language         = (language && *language) ? language : "auto";

    if (whisper_full(ctx, params, samples, n_samples) != 0) {
        snprintf(error_buf, error_buf_size, "whisper_full に失敗");
        return -1;
    }

    std::string result;
    int n = whisper_full_n_segments(ctx);
    for (int i = 0; i < n; i++) {
        const char* seg = whisper_full_get_segment_text(ctx, i);
        if (seg) result += seg;
    }

    strncpy(output_buf, result.c_str(), output_buf_size - 1);
    output_buf[output_buf_size - 1] = '\0';
    return 0;
}
