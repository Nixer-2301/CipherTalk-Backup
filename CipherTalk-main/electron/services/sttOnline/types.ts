export type OnlineProvider =
  | 'openai-compatible'
  | 'aliyun-qwen-asr'
  | 'qianwen-cloud'
  | 'volcano-doubao'
  | 'custom'

export interface OnlineTranscribeConfig {
  provider: OnlineProvider
  apiKey: string
  baseURL: string
  model: string
  language: string
  timeoutMs: number
}

export type OnlineTranscribeOverrides = Partial<OnlineTranscribeConfig>

export interface TranscribeResult {
  success: boolean
  transcript?: string
  error?: string
}

export interface TestResult {
  success: boolean
  error?: string
}

/**
 * 单个在线转写服务商的实现。编排器负责加载配置、校验、超时/中断包装，
 * provider 只管按各家协议构造请求、解析响应。新增服务商 = 新增一个实现该接口的文件 + 在注册表登记一行。
 */
export interface OnlineSttProvider {
  transcribe(
    wavData: Buffer,
    config: OnlineTranscribeConfig,
    signal: AbortSignal,
    onPartial?: (text: string) => void
  ): Promise<TranscribeResult>
  test(config: OnlineTranscribeConfig, signal: AbortSignal): Promise<TestResult>
}
