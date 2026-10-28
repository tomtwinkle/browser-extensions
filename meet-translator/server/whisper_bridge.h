/* whisper_bridge.h – whisper.cpp への最小 C ブリッジ */
#ifndef WHISPER_BRIDGE_H
#define WHISPER_BRIDGE_H

#ifdef __cplusplus
extern "C" {
#endif

typedef struct whisper_context whisper_context;

/*
 * whisper_bridge_init_from_file
 *   モデルをロードしてコンテキストを返す。NULL = 失敗。
 */
whisper_context* whisper_bridge_init(const char* model_path);

/*
 * whisper_bridge_free
 */
void whisper_bridge_free(whisper_context* ctx);

/*
 * whisper_bridge_transcribe
 *   samples:        float32 モノラル 16kHz サンプル列
 *   n_samples:      サンプル数
 *   language:       "en"/"ja"/... または "" (自動検出)
 *   initial_prompt: glossary などの補助ヒント。NULL または "" で無効。
 *   lang_out_buf:   Whisper が検出した言語コードの出力先 (e.g. "ja", "en", "vi")
 *   lang_out_size:  lang_out_buf のバイト数
 *   segments_buf:   Whisper が返した区間とスコアを含む JSON 配列
 *   segments_size:  segments_buf のバイト数
 *   戻り値: 0=成功
 */
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
);

/* Return whether a decoded Whisper segment contains displayable candidate text. */
int whisper_bridge_has_candidate_text(const char* text, int token_count);

#ifdef __cplusplus
}
#endif

#endif /* WHISPER_BRIDGE_H */
