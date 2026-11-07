// AI 元数据不进入业务工具目录；只能由检查租户、会话归属与授权的服务读写。
export const AI_MIGRATION = { name: 'cage:ai_001', sql: `
CREATE TABLE sys.ai_session (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid NOT NULL, title text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_session_owner_idx ON sys.ai_session(tenant_id,user_id,updated_at DESC);
CREATE TABLE sys.ai_run (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid, session_id uuid REFERENCES sys.ai_session(id),
 mode text NOT NULL CHECK(mode IN ('assistant','approval')), status text NOT NULL, phase text NOT NULL DEFAULT 'context',
 input text NOT NULL DEFAULT '', page_context jsonb, context jsonb, history jsonb NOT NULL DEFAULT '[]', pending jsonb NOT NULL DEFAULT '[]',
 model text NOT NULL, instructions text NOT NULL DEFAULT '', limits jsonb NOT NULL, fingerprint text NOT NULL, auth_fingerprint text,
 auth_session text, delegated_until timestamptz NOT NULL, step_up_at bigint,
 approval_step_id uuid, process text, policy jsonb, request_key text, request_hash text,
 steps integer NOT NULL DEFAULT 0, tool_calls integer NOT NULL DEFAULT 0, tokens integer NOT NULL DEFAULT 0,
 next_seq integer NOT NULL DEFAULT 0, lease_token uuid, lease_until timestamptz, deadline timestamptz,
 cancelled boolean NOT NULL DEFAULT false, answer text, error text, failures integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,user_id,request_key), UNIQUE(approval_step_id)
);
CREATE INDEX ai_run_queue_idx ON sys.ai_run(status,created_at);
CREATE INDEX ai_run_session_idx ON sys.ai_run(session_id,created_at);
CREATE TABLE sys.ai_event (
 run_id uuid NOT NULL REFERENCES sys.ai_run(id), sequence integer NOT NULL, type text NOT NULL, data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_id,sequence)
);
CREATE TABLE sys.ai_action (
 id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES sys.ai_run(id), tenant_id uuid NOT NULL,
 call_id text NOT NULL, tool text NOT NULL, input jsonb NOT NULL, input_hash text NOT NULL,
 status text NOT NULL DEFAULT 'planned', result jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id,call_id)
);
CREATE TABLE sys.ai_interaction (
 id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES sys.ai_run(id), action_id uuid REFERENCES sys.ai_action(id),
 kind text NOT NULL, prompt text NOT NULL, data jsonb NOT NULL, response jsonb,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), answered_at timestamptz
);
CREATE TABLE sys.ai_memory (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid NOT NULL, key text NOT NULL, value text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,user_id,key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON sys.ai_session,sys.ai_run,sys.ai_event,sys.ai_action,sys.ai_interaction,sys.ai_memory TO cage_app;
` };
