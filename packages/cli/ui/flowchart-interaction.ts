export interface FlowPoint {
  x: number;
  y: number;
}

export interface FlowCamera extends FlowPoint {
  scale: number;
  initialized: boolean;
  width?: number;
  height?: number;
}

export const MIN_FLOW_ZOOM = 0.1;
export const MAX_FLOW_ZOOM = 4;

/** 缩放时保留光标下的业务位置，避免图像向画布中心跳动。 */
export function zoomFlowCamera(camera: FlowCamera, scale: number, anchor: FlowPoint) {
  const next = Math.min(MAX_FLOW_ZOOM, Math.max(MIN_FLOW_ZOOM, scale));
  camera.x = anchor.x - ((anchor.x - camera.x) * next) / camera.scale;
  camera.y = anchor.y - ((anchor.y - camera.y) * next) / camera.scale;
  camera.scale = next;
}

/** 详情占用画布空间时，只移动到足以看清所选节点的位置，保留用户的缩放。 */
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

interface FlowPointer {
  id: number;
  point: FlowPoint;
  touch: boolean;
  /** 抓手模式、中键和空格均强制移动画布，不触发节点点击。 */
  pan: boolean;
  node?: string;
  target?: string;
}

/** DOM 只负责命中与捕获指针。这里统一区分点击、节点拖动、平移和双指手势，
 * 拖动结束不会误打开详情；节点位移使用业务坐标而非屏幕像素。 */
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
  const pair = () => {
    const [a, b] = touches();
    return {
      center: { x: (a.point.x + b.point.x) / 2, y: (a.point.y + b.point.y) / 2 },
      distance: Math.max(1, Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y)),
    };
  };
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
    start(pointer: FlowPointer) {
      pointers.set(pointer.id, pointer);
      if (touches().length >= 2) {
        pinch = { ...pair(), camera: { ...camera } };
        drag = undefined;
      } else beginDrag(pointer);
    },
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
    cancel() {
      pointers.clear();
      drag = undefined;
      pinch = undefined;
    },
  };
}
