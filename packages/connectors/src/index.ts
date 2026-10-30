// @yss123/cage-connectors：第三方连接器原语与运行时。
export {
  connector, op, outbound, inbound, hmacSha256,
  type Connector, type ConnectorDef, type Op, type OpDef, type Effect, type Outbound, type Inbound, type Verifier,
} from './primitives.js';
export {
  call, stage, secrets, setSecretProvider, fakeConnector, fakeCalls, sampleFromSchema, outboundConsumer, ConnectorError,
  type SecretProvider,
} from './runtime.js';
