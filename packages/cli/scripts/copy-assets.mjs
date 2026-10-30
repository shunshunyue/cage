// npm 包包含模板和错误码册；源码构建从仓库规范目录复制，运行时不依赖仓库布局。
import { cpSync } from 'node:fs';
const here = new URL('../', import.meta.url);
cpSync(new URL('../../templates/app/', here), new URL('templates/app/', here), { recursive: true });
cpSync(new URL('../../docs/errors/', here), new URL('managed/errors/', here), { recursive: true });
