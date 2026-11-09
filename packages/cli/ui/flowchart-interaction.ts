/**
 * 流程画布的坐标与手势状态机，与 DOM 命中检测分离以便独立验证。
 * 统一处理鼠标节点拖动、空白平移、触控点击及双指缩放，原地更新相机并通过回调通知渲染层。
 * 坐标分为屏幕像素和缩放前业务坐标；这里只管理交互，不保存服务端数据，也不主动注册全局事件。
 */
/**
 * 二维点；具体参数说明其属于屏幕相对坐标还是缩放前业务坐标。
 */
export interface FlowPoint {
  /** 水平坐标；调用处明确使用屏幕像素或业务坐标。 */
  x: number;
  /** 垂直坐标，单位与同一对象的 x 一致。 */
  y: number;
}

/**
 * 持久阅读视野，平移为屏幕像素，scale 为比例，width/height 在 mount/resize 后记录。
 */
export interface FlowCamera extends FlowPoint {
  /** 业务坐标到屏幕像素的倍率，共用最小/最大值限幅。 */
  scale: number;
  /** 首次挂载已经选择阅读起点或适应视野，后续不自动重置。 */
  initialized: boolean;
  /** 最近记录的画布可见宽度，像素；挂载前可缺省。 */
  width?: number;
  /** 最近记录的画布可见高度，像素；挂载前可缺省。 */
  height?: number;
}

/**
 * 流程画布最小倍率 0.1，避免缩放降至不可操作或出现除零。
 */
export const MIN_FLOW_ZOOM = 0.1;
/**
 * 流程画布最大倍率 4，用于滚轮、按钮与双指缩放共同限幅。
 */
export const MAX_FLOW_ZOOM = 4;

/** 缩放时保留光标下的业务位置，避免图像向画布中心跳动。 */
/**
 * 以屏幕锚点缩放，保持锚点下的业务坐标不变。
 * @param camera 原地修改的相机。
 * @param scale 期望倍率，限制在公开最小/最大值。
 * @param anchor 相对画布的屏幕像素点。
 */
export function zoomFlowCamera(camera: FlowCamera, scale: number, anchor: FlowPoint) {
  const next = Math.min(MAX_FLOW_ZOOM, Math.max(MIN_FLOW_ZOOM, scale));
  camera.x = anchor.x - ((anchor.x - camera.x) * next) / camera.scale;
  camera.y = anchor.y - ((anchor.y - camera.y) * next) / camera.scale;
  camera.scale = next;
}

/** 详情占用画布空间时，只移动到足以看清所选节点的位置，保留用户的缩放。 */
/**
 * 只平移视野使目标可读，不改变用户倍率；超高审批容器优先露出顶部。
 * @param camera 已记录画布宽高的相机，原地更新。
 * @param position 目标缩放前位置和尺寸。
 */
export function revealFlowPosition(
  camera: FlowCamera,
  position: FlowPoint & { width: number; height: number },
) {
  const left = camera.x + position.x * camera.scale,
    top = camera.y + position.y * camera.scale;
  const width = position.width * camera.scale,
    height = position.height * camera.scale;
  const right = camera.width! - 24,
    bottom = camera.height! - 68;
  camera.x +=
    width > right - 24
      ? (camera.width! - width) / 2 - left
      : left < 24
        ? 24 - left
        : left + width > right
          ? right - left - width
          : 0;
  camera.y +=
    height > bottom - 24
      ? // 长审批按阅读顺序从顶部开始，保留当前缩放；居中会把标题和首个审批人裁掉。
        24 - top
      : top < 24
        ? 24 - top
        : top + height > bottom
          ? bottom - top - height
          : 0;
}

/**
 * 规范化像素/行/页滚轮单位，再选择横向平移或锚点缩放。
 * @param camera 原地修改的相机。
 * @param wheel 滚轮增量及 Shift 状态。
 * @param anchor 缩放锚点；Shift 或横向主导时仅平移。
 */
export function wheelFlowCamera(
  camera: FlowCamera,
  wheel: { deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean },
  anchor: FlowPoint,
) {
  const unit = wheel.deltaMode === 1 ? 16 : wheel.deltaMode === 2 ? camera.height! : 1;
  const dx = wheel.deltaX * unit,
    dy = wheel.deltaY * unit;
  if (wheel.shiftKey) camera.x -= dx || dy;
  else if (Math.abs(dx) > Math.abs(dy)) camera.x -= dx;
  else zoomFlowCamera(camera, camera.scale * Math.exp(-Math.max(-240, Math.min(240, dy)) * 0.002), anchor);
}

/**
 * 本次捕获指针的命中数据，touch 强制单指平移，target 只用于未拖动的点击激活。
 */
interface FlowPointer {
  /** 浏览器 pointerId，用于追踪当前活动指针。 */
  id: number;
  /** 相对画布左上角的屏幕像素位置。 */
  point: FlowPoint;
  /** 是否为触摸指针；单指优先平移，双指缩放。 */
  touch: boolean;
  /** 抓手模式、中键和空格均强制移动画布，不触发节点点击。 */
  pan: boolean;
  /** 可拖动节点的步骤 ID；空白或连线可缺省。 */
  node?: string;
  /** 未达到拖动阈值时激活的步骤/关系标识。 */
  target?: string;
}

/** DOM 只负责命中与捕获指针。这里统一区分点击、节点拖动、平移和双指手势，
 * 拖动结束不会误打开详情；节点位移使用业务坐标而非屏幕像素。 */
/**
 * 创建独立手势状态机，节点拖动按开始倍率换算业务位移。
 * @param camera 共享相机，平移/双指会原地修改。
 * @param actions 提供位置、移动、激活及重绘回调。
 * @returns start/move/end/cancel 操作；4 像素阈值区分点击，取消不触发激活，不自行安装 DOM 监听器。
 */
export function createFlowGestures(
  camera: FlowCamera,
  actions: {
    position: (id: string) => FlowPoint;
    move: (id: string, point: FlowPoint) => void;
    activate: (target: string) => void;
    changed: () => void;
  },
) {
  const pointers = new Map<number, FlowPointer>();
  let drag:
    | {
        pointer: FlowPointer;
        start: FlowPoint;
        origin: FlowPoint;
        scale: number;
        moved: boolean;
        node?: string;
      }
    | undefined;
  let pinch: { center: FlowPoint; distance: number; camera: FlowCamera } | undefined;
  const touches = () => [...pointers.values()].filter((pointer) => pointer.touch);
  /**
   * 读取前两个触点的中心与距离，距离至少 1 像素避免重合时除零；只在双触点状态调用。
   */
  const pair = () => {
    const [a, b] = touches();
    return {
      center: { x: (a.point.x + b.point.x) / 2, y: (a.point.y + b.point.y) / 2 },
      distance: Math.max(1, Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y)),
    };
  };
  /**
   * 保存手势起点、原始位置及开始倍率，后续位移不累计误差；双指退回单指时 moved=true 抑制误点击。
   */
  const beginDrag = (pointer: FlowPointer, moved = false) => {
    // 单指拖动始终平移，节点仍可轻点打开；双指接管缩放与平移。
    const node = pointer.pan || pointer.touch ? undefined : pointer.node;
    drag = {
      pointer,
      start: { ...pointer.point },
      origin: { ...(node ? actions.position(node) : camera) },
      scale: camera.scale,
      moved,
      node,
    };
  };
  return {
    /**
     * 登记指针；第二个触点出现时改由双指相机接管，并放弃原单指拖动。
     */
    start(pointer: FlowPointer) {
      pointers.set(pointer.id, pointer);
      if (touches().length >= 2) {
        pinch = { ...pair(), camera: { ...camera } };
        drag = undefined;
      } else beginDrag(pointer);
    },
    /**
     * 按指针身份更新坐标；双指同时缩放/平移，单指超过 4 像素才按起始快照移动。
     */
    move(id: number, point: FlowPoint) {
      const pointer = pointers.get(id);
      if (!pointer) return;
      pointer.point = point;
      if (pinch) {
        const current = pair();
        const scale = Math.min(
          MAX_FLOW_ZOOM,
          Math.max(MIN_FLOW_ZOOM, (pinch.camera.scale * current.distance) / pinch.distance),
        );
        camera.x = current.center.x - ((pinch.center.x - pinch.camera.x) * scale) / pinch.camera.scale;
        camera.y = current.center.y - ((pinch.center.y - pinch.camera.y) * scale) / pinch.camera.scale;
        camera.scale = scale;
      } else if (drag?.pointer.id === id) {
        const dx = point.x - drag.start.x,
          dy = point.y - drag.start.y;
        drag.moved ||= Math.hypot(dx, dy) > 4;
        if (!drag.moved) return;
        if (drag.node)
          actions.move(drag.node, { x: drag.origin.x + dx / drag.scale, y: drag.origin.y + dy / drag.scale });
        else {
          camera.x = drag.origin.x + dx;
          camera.y = drag.origin.y + dy;
        }
      }
      actions.changed();
    },
    /**
     * 删除结束指针并衔接剩余触点；只有未取消、未移动且未强制平移的单指操作可激活目标。
     */
    end(id: number, cancelled = false) {
      pointers.delete(id);
      if (pinch) {
        if (touches().length >= 2) pinch = { ...pair(), camera: { ...camera } };
        else {
          pinch = undefined;
          const remaining = touches()[0];
          if (remaining) beginDrag(remaining, true);
        }
      } else if (drag?.pointer.id === id) {
        const click = !cancelled && !drag.moved && !drag.pointer.pan ? drag.pointer.target : undefined;
        drag = undefined;
        if (click) actions.activate(click);
      }
    },
    /**
     * 清空手势临时状态而不触发激活，用于组件销毁或显式取消。
     */
    cancel() {
      pointers.clear();
      drag = undefined;
      pinch = undefined;
    },
  };
}
