// @yss123/cage-connectors：第三方连接器原语与运行时。
/**
 * 声明入口提供外部协议与事件映射，运行入口负责真实 IO/fake 和恢复协议。
 * 业务 handler 不直接调用此包的网络接口；异步写入通过 outbound，入站结果通过领域命令落实。
 */
export { streamJson } from './stream.js';
export {
  connector, op, outbound, inbound, hmacSha256,
  type Connector, type ConnectorDef, type Op, type OpDef, type Effect, type Outbound, type Inbound, type Verifier,
} from './primitives.js';
export {
  call, stage, secrets, setSecretProvider, fakeConnector, fakeCalls, sampleFromSchema, outboundConsumer, ConnectorError,
  type SecretProvider,
} from './runtime.js';
