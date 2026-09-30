// whisper_bridge.cpp – whisper.cpp C++ 実装ブリッジ

#include "whisper_bridge.h"
#include "whisper.h"

#include <cctype>
#include <cmath>
#include <cstring>
#include <cstdio>
#include <limits>
#include <string>
#include <vector>

namespace {

constexpr int kWhisperThreads = 4;
constexpr float kWhisperLogprobThreshold = -0.8f;
constexpr float kWhisperNoSpeechThreshold = 0.6f;

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

    return counted > 0 ? sum / counted : std::numeric_limits<float>::quiet_NaN();
}

std::string json_escape(const char* text) {
    std::string escaped;
    if (!text) {
        return escaped;
    }
    for (const unsigned char c : std::string(text)) {
        switch (c) {
            case '"': escaped += "\\\""; break;
            case '\\': escaped += "\\\\"; break;
            case '\b': escaped += "\\b"; break;
            case '\f': escaped += "\\f"; break;
            case '\n': escaped += "\\n"; break;
            case '\r': escaped += "\\r"; break;
            case '\t': escaped += "\\t"; break;
            default:
                if (c < 0x20) {
                    char escaped_control[7];
                    std::snprintf(escaped_control, sizeof(escaped_control), "\\u%04x", c);
                    escaped += escaped_control;
                } else {
                    escaped.push_back(static_cast<char>(c));
                }
        }
    }
    return escaped;
}

std::string json_number(double value) {
    if (!std::isfinite(value)) {
        return "null";
    }
    char number[64];
    std::snprintf(number, sizeof(number), "%.9g", value);
    return number;
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

int whisper_bridge_has_candidate_text(const char* text, int token_count) {
    const std::string trimmed = trim_ascii_whitespace(text);
    return !trimmed.empty() && token_count > 0 ? 1 : 0;
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
    char*            segments_buf,
    int              segments_size,
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

    // Whisper が実際に聞き取った言語を取得する。
    // whisper_full_lang_id() は caller が固定言語を渡した場合にそのヒントを返すため、
    // mel から再推定した結果を優先して background 側の翻訳方向判定に渡す。
    if (lang_out_buf && lang_out_size > 0) {
        int lang_id = -1;
        std::vector<float> lang_probs(whisper_lang_max_id() + 1, 0.0f);
        if (!lang_probs.empty()) {
            lang_id = whisper_lang_auto_detect(ctx, 0, kWhisperThreads, lang_probs.data());
        }
        if (lang_id < 0) {
            lang_id = whisper_full_lang_id(ctx);
        }
        const char* lang_str = whisper_lang_str(lang_id);
        strncpy(lang_out_buf, lang_str ? lang_str : "", lang_out_size - 1);
        lang_out_buf[lang_out_size - 1] = '\0';
    }

    std::string result;
    std::string segments_json = "[";
    bool first_segment = true;
    int n = whisper_full_n_segments(ctx);
    for (int i = 0; i < n; i++) {
        const char* seg = whisper_full_get_segment_text(ctx, i);
        if (!seg) {
            continue;
        }

        const int n_tokens = whisper_full_n_tokens(ctx, i);
        const float avg_logprob = whisper_bridge_segment_avg_logprob(ctx, i);
        const float no_speech_prob = whisper_full_get_segment_no_speech_prob(ctx, i);

        if (!whisper_bridge_has_candidate_text(seg, n_tokens)) {
            continue;
        }

        result += seg;
        if (!first_segment) {
            segments_json += ",";
        }
        first_segment = false;
        const double start_ms = static_cast<double>(whisper_full_get_segment_t0(ctx, i)) * 10.0;
        const double end_ms = static_cast<double>(whisper_full_get_segment_t1(ctx, i)) * 10.0;
        segments_json += "{\"start_ms\":" + json_number(start_ms);
        segments_json += ",\"end_ms\":" + json_number(end_ms);
        segments_json += ",\"text\":\"" + json_escape(seg) + "\"";
        segments_json += ",\"avg_logprob\":" + json_number(avg_logprob);
        segments_json += ",\"no_speech_probability\":" + json_number(no_speech_prob) + "}";
    }
    segments_json += "]";

    if (!output_buf || output_buf_size <= 0 || result.size() >= static_cast<size_t>(output_buf_size)) {
        snprintf(error_buf, error_buf_size, "Whisper transcript exceeds output buffer");
        return -3;
    }
    if (!segments_buf || segments_size <= 0 || segments_json.size() >= static_cast<size_t>(segments_size)) {
        snprintf(error_buf, error_buf_size, "Whisper segment metadata exceeds output buffer");
        return -2;
    }

    strncpy(output_buf, result.c_str(), output_buf_size - 1);
    output_buf[output_buf_size - 1] = '\0';
    strncpy(segments_buf, segments_json.c_str(), segments_size - 1);
    segments_buf[segments_size - 1] = '\0';
    return 0;
}
