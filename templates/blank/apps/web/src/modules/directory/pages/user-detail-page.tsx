import { Link, useParams } from 'react-router-dom';
import { UserSchema, useUser } from '@app/contracts';
import { PageState, QueryFailure } from '../../../shared/ui/page-state';

/** ID 来自地址栏，详情不依赖“先打开列表”的内存对象，也不自行放宽读侧权限。 */
export function UserDetailPage() {
  const { id } = useParams();
  const parsed = UserSchema.shape.id.safeParse(id);
  if (!parsed.success)
    return <PageState title="成员地址无效" description="请从成员目录选择有效记录。" to="/directory/users" />;
  return <UserDetail id={parsed.data} />;
}

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
