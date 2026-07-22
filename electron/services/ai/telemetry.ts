/**
 * 外部 OpenTelemetry 接入：注册 AI SDK 7 的 `registerTelemetry`，把 generateText/streamText/
 * ToolLoopAgent 的生命周期事件转成 OTel span 发给外部 collector。
 * 未配置 OTEL_EXPORTER_OTLP_ENDPOINT（或 _TRACES_ENDPOINT）时直接跳过，零开销。
 * 主进程和 AI utility 子进程各自独立调用一次（各自的模块状态、各自的 Node 进程）。
 */
import { registerTelemetry } from 'ai'
import { OpenTelemetry } from '@ai-sdk/otel'
import { trace } from '@opentelemetry/api'
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'

let initialized = false

export function initAiTelemetry(serviceName: string): void {
  if (initialized) return
  initialized = true
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  if (!endpoint) return
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': process.env.OTEL_SERVICE_NAME || serviceName }),
    // exporter 本身按 OTel 规范读 OTEL_EXPORTER_OTLP_HEADERS / _PROTOCOL 等环境变量，这里不重复解析
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  })
  provider.register()
  registerTelemetry(new OpenTelemetry({ tracer: trace.getTracer(serviceName) }))
}
