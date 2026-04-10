// whisper_bridge.cpp – whisper.cpp C++ 実装ブリッジ

#include "whisper_bridge.h"
#include "whisper.h"

#include <cctype>
#include <cstring>
#include <cstdio>
#include <string>

namespace {

constexpr int kWhisperThreads = 4;
constexpr float kWhisperLogprobThreshold = -0.8f;
constexpr float kWhisperNoSpeechThreshold = 0.6f;
constexpr float kSegmentLogprobDropThreshold = -0.8f;
constexpr float kSegmentNoSpeechDropThreshold = 0.75f;

std::string trim_ascii_whitespace(const char* text) {
    if (!text) {
        return "";
    }

    std::string trimmed(text);
    size_t start = 0;
    while (start < trimmed.size() && std::isspace(static_cast<unsigned char>(trimmed[start]))) {
        ++start;
    }

    size_t end = trimmed.size();
    while (end > start && std::isspace(static_cast<unsigned char>(trimmed[end - 1]))) {
        --end;
    }

    return trimmed.substr(start, end - start);
}

float whisper_bridge_segment_avg_logprob(whisper_context* ctx, int segment_index) {
    const int n_tokens = whisper_full_n_tokens(ctx, segment_index);
    if (n_tokens <= 0) {
        return 0.0f;
    }

    const whisper_token timestamp_begin = whisper_token_beg(ctx);
    const whisper_token token_eot = whisper_token_eot(ctx);

    float sum = 0.0f;
    int counted = 0;
    for (int i = 0; i < n_tokens; ++i) {
        whisper_token_data token = whisper_full_get_token_data(ctx, segment_index, i);
        if (token.id == token_eot || token.id > timestamp_begin) {
            continue;
        }

        const char* token_text = whisper_full_get_token_text(ctx, segment_index, i);
        if (!token_text || !*token_text) {
            continue;
        }

        bool has_non_space = false;
        for (const char* p = token_text; *p; ++p) {
            if (!std::isspace(static_cast<unsigned char>(*p))) {
                has_non_space = true;
                break;
            }
        }
        if (!has_non_space) {
            continue;
        }

        sum += token.plog;
        ++counted;
    }

    return counted > 0 ? sum / counted : 0.0f;
}

} // namespace

whisper_context* whisper_bridge_init(const char* model_path) {
    whisper_context_params cparams = whisper_context_default_params();
    cparams.use_gpu = true; // Metal/CUDA が有効なら自動で GPU を使う
    return whisper_init_from_file_with_params(model_path, cparams);
}

void whisper_bridge_free(whisper_context* ctx) {
    if (ctx) whisper_free(ctx);
}

int whisper_bridge_should_keep_segment(
    const char* text,
    int         token_count,
    float       avg_logprob,
    float       no_speech_prob
) {
    const std::string trimmed = trim_ascii_whitespace(text);
    if (trimmed.empty() || token_count <= 0) {
        return 0;
    }

    if (no_speech_prob >= kSegmentNoSpeechDropThreshold &&
        avg_logprob <= kSegmentLogprobDropThreshold) {
        return 0;
    }

    return 1;
}

int whisper_bridge_transcribe(
    whisper_context* ctx,
    const float*     samples,
    int              n_samples,
    const char*      language,
    const char*      initial_prompt,
    char*            output_buf,
    int              output_buf_size,
    char*            lang_out_buf,
    int              lang_out_size,
    char*            error_buf,
    int              error_buf_size
) {
    whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.n_threads        = kWhisperThreads;
    params.no_context       = true;
    params.print_progress   = false;
    params.print_realtime   = false;
    params.print_timestamps = false;
    params.suppress_blank   = true;
    params.suppress_nst     = true;
    params.logprob_thold    = kWhisperLogprobThreshold;
    params.no_speech_thold  = kWhisperNoSpeechThreshold;
    params.language         = (language && *language) ? language : "auto";
    params.initial_prompt   = (initial_prompt && *initial_prompt) ? initial_prompt : nullptr;

    if (whisper_full(ctx, params, samples, n_samples) != 0) {
        snprintf(error_buf, error_buf_size, "whisper_full に失敗");
        return -1;
    }

    // Whisper が検出した言語を取得
    if (lang_out_buf && lang_out_size > 0) {
        int lang_id = whisper_full_lang_id(ctx);
        const char* lang_str = whisper_lang_str(lang_id);
        strncpy(lang_out_buf, lang_str ? lang_str : "", lang_out_size - 1);
        lang_out_buf[lang_out_size - 1] = '\0';
    }

    std::string result;
    int n = whisper_full_n_segments(ctx);
    for (int i = 0; i < n; i++) {
        const char* seg = whisper_full_get_segment_text(ctx, i);
        if (!seg) {
            continue;
        }

        const int n_tokens = whisper_full_n_tokens(ctx, i);
        const float avg_logprob = whisper_bridge_segment_avg_logprob(ctx, i);
        const float no_speech_prob = whisper_full_get_segment_no_speech_prob(ctx, i);

        if (!whisper_bridge_should_keep_segment(seg, n_tokens, avg_logprob, no_speech_prob)) {
            continue;
        }

        result += seg;
    }

    strncpy(output_buf, result.c_str(), output_buf_size - 1);
    output_buf[output_buf_size - 1] = '\0';
    return 0;
}
