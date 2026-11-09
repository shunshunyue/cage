/**
 * 成员详情路由，从地址栏独立校验和加载成员，支持直接访问与刷新。
 * 姓名、联系方式等均来自安全契约结果，敏感字段是否可见由后端决定。
 */
import { Link, useParams } from 'react-router-dom';
import { UserSchema, useUser } from '@app/contracts';
import { PageState, QueryFailure } from '../../../shared/ui/page-state';

/** ID 来自地址栏，详情不依赖“先打开列表”的内存对象，也不自行放宽读侧权限。 */
/**
 * 校验 URL 中的成员 id，非法时显示地址错误与返回目录入口；通过后才挂载读取组件。
 */
export function UserDetailPage() {
  const { id } = useParams();
  const parsed = UserSchema.shape.id.safeParse(id);
  if (!parsed.success)
    return <PageState title="成员地址无效" description="请从成员目录选择有效记录。" to="/directory/users" />;
  return <UserDetail id={parsed.data} />;
}

/**
 * 对合法 id 调用 useUser，分别呈现加载、权限/范围/网络错误及真实成员信息。
 * 电话邮箱为空时显示未填写；该展示不能恢复被服务端掩码或裁剪的原始字段。
 */
function UserDetail({ id }: { id: string }) {
  const query = useUser(id);
  if (query.isPending)
    return (
      <p className="muted" role="status">
        正在读取成员详情…
      </p>
    );
  if (query.isError)
    return <QueryFailure error={query.error} to="/directory/users" retry={() => void query.refetch()} />;
  const user = query.data;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">成员详情</p>
          <h1>{user.name}</h1>
          <p className="muted">联系方式按当前账号的权限展示。</p>
        </div>
        <Link className="route-link" to="/directory/users">
          ← 返回成员目录
        </Link>
      </div>
      <section className="directory-panel">
        <dl className="record-facts">
          <div>
            <dt>账号</dt>
            <dd>{user.username}</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>{user.status === 'active' ? '使用中' : '已停用'}</dd>
          </div>
          <div>
            <dt>电话</dt>
            <dd>{user.phone ?? '未填写'}</dd>
          </div>
          <div>
            <dt>邮箱</dt>
            <dd>{user.email ?? '未填写'}</dd>
          </div>
          <div>
            <dt>成员 ID</dt>
            <dd>{user.id}</dd>
          </div>
          <div>
            <dt>加入时间</dt>
            <dd>{new Date(user.createdAt).toLocaleString('zh-CN')}</dd>
          </div>
        </dl>
      </section>
    </>
  );
}
