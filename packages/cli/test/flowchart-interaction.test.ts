/**
 * 验证流程画布的坐标换算和指针状态机。
 * 纯内存相机与回调覆盖锚点缩放、节点拖动、抓手/触控平移、双指接管、取消及点击阈值。
 * 测试不依赖 DOM，几何与手势结果仍需浏览器层正确完成命中检测和事件捕获。
 */
import { expect, it, vi } from 'vitest';
import {
  createFlowGestures,
  wheelFlowCamera,
  zoomFlowCamera,
  revealFlowPosition,
  type FlowCamera,
  type FlowPoint,
} from '../ui/flowchart-interaction.js';

/**
 * 建立固定画布、单节点位置及可观测激活回调，允许用例改变初始缩放倍数。
 * pointer 工厂产生鼠标节点命中数据；用例显式覆盖 touch/pan 来验证接管逻辑。
 */
function fixture(scale = 1) {
  const camera: FlowCamera = { x: 10, y: 20, scale, initialized: true, width: 800, height: 600 };
  const positions = new Map<string, FlowPoint>([['approve', { x: 100, y: 100 }]]);
  const activate = vi.fn();
  const gestures = createFlowGestures(camera, {
    position: (id) => positions.get(id)!,
    move: (id, point) => positions.set(id, point),
    activate,
    changed: vi.fn(),
  });
  const pointer = (id: number, x: number, y: number) => ({
    id,
    point: { x, y },
    touch: false,
    pan: false,
    node: 'approve',
    target: 'approve',
  });
  return { camera, positions, activate, gestures, pointer };
}

it('普通滚轮直接缩放并保留光标下的业务坐标，行与像素增量一致', () => {
  const { camera } = fixture();
  const anchor = { x: 320, y: 200 };
  const world = { x: (anchor.x - camera.x) / camera.scale, y: (anchor.y - camera.y) / camera.scale };
  wheelFlowCamera(camera, { deltaX: 0, deltaY: -48, deltaMode: 0, shiftKey: false }, anchor);
  expect(camera.scale).toBeGreaterThan(1);
  expect((anchor.x - camera.x) / camera.scale).toBeCloseTo(world.x);
  expect((anchor.y - camera.y) / camera.scale).toBeCloseTo(world.y);
  const lines = fixture().camera;
  wheelFlowCamera(lines, { deltaX: 0, deltaY: -3, deltaMode: 1, shiftKey: false }, anchor);
  expect(lines).toEqual(camera);
});

it('缩放到上下限后继续滚动不会漂移，100%仍以指定锚点还原', () => {
  const { camera } = fixture();
  const anchor = { x: 400, y: 300 };
  zoomFlowCamera(camera, 100, anchor);
  expect(camera.scale).toBe(4);
  const maximum = { ...camera };
  zoomFlowCamera(camera, 100, anchor);
  expect(camera).toEqual(maximum);
  zoomFlowCamera(camera, 0.001, anchor);
  expect(camera.scale).toBe(0.1);
  zoomFlowCamera(camera, 1, anchor);
  expect(camera.x).toBeCloseTo(10);
  expect(camera.y).toBeCloseTo(20);
});

it('Shift滚轮和横向触控板增量平移画布，不改变缩放', () => {
  const { camera } = fixture(2);
  wheelFlowCamera(camera, { deltaX: 0, deltaY: 60, deltaMode: 0, shiftKey: true }, { x: 0, y: 0 });
  expect(camera).toMatchObject({ x: -50, y: 20, scale: 2 });
  wheelFlowCamera(camera, { deltaX: -30, deltaY: 2, deltaMode: 0, shiftKey: false }, { x: 0, y: 0 });
  expect(camera).toMatchObject({ x: -20, y: 20, scale: 2 });
});

it('详情挤占画布时以最小位移露出节点，已经可见的节点不引起跳动', () => {
  const { camera } = fixture();
  const position = { x: 700, y: 200, width: 200, height: 100 };
  revealFlowPosition(camera, position);
  expect(camera).toMatchObject({ x: -124, y: 20, scale: 1 });
  expect(camera.x + position.x + position.width).toBe(776);
  const visible = { ...camera };
  revealFlowPosition(camera, position);
  expect(camera).toEqual(visible);
});

it('高于画布的审批从标题和首个步骤开始阅读，保留缩放且重复定位不跳动', () => {
  const camera = { x: 0, y: -600, scale: 0.9, initialized: true, width: 800, height: 500 };
  const position = { x: 100, y: 800, width: 400, height: 1000 };
  revealFlowPosition(camera, position);
  expect(camera.y + position.y * camera.scale).toBe(24);
  expect(camera.scale).toBe(0.9);
  const before = { ...camera };
  revealFlowPosition(camera, position);
  expect(camera).toEqual(before);
});

it('拖动空白处平移，拖动节点按缩放换算位移，均不误打开详情', () => {
  const { camera, gestures, pointer, positions, activate } = fixture(2);
  gestures.start({ ...pointer(1, 40, 60), node: undefined, target: undefined });
  gestures.move(1, { x: 140, y: 100 });
  gestures.end(1);
  expect(camera).toMatchObject({ x: 110, y: 60, scale: 2 });
  gestures.start(pointer(2, 40, 60));
  gestures.move(2, { x: 140, y: 100 });
  gestures.end(2);
  expect(positions.get('approve')).toEqual({ x: 150, y: 120 });
  expect(camera).toMatchObject({ x: 110, y: 60, scale: 2 });
  expect(activate).not.toHaveBeenCalled();
});

it('抓手或空格可从节点开始平移，轻点才打开详情，取消手势不激活', () => {
  const { camera, gestures, pointer, positions, activate } = fixture();
  gestures.start({ ...pointer(1, 40, 60), pan: true });
  gestures.move(1, { x: 140, y: 100 });
  gestures.end(1);
  expect(camera).toMatchObject({ x: 110, y: 60 });
  expect(positions.get('approve')).toEqual({ x: 100, y: 100 });
  gestures.start(pointer(2, 40, 60));
  gestures.move(2, { x: 42, y: 61 });
  gestures.end(2);
  expect(activate).toHaveBeenCalledExactlyOnceWith('approve');
  gestures.start(pointer(3, 40, 60));
  gestures.end(3, true);
  expect(activate).toHaveBeenCalledTimes(1);
});

it('触屏双指同时缩放与平移，松开一指后继续移动不会误触节点', () => {
  const { camera, gestures, pointer, positions, activate } = fixture();
  gestures.start({ ...pointer(1, 100, 100), touch: true });
  gestures.start({ ...pointer(2, 200, 100), touch: true });
  gestures.move(2, { x: 300, y: 100 });
  expect(camera).toMatchObject({ scale: 2, x: -80, y: -60 });
  gestures.end(2);
  gestures.move(1, { x: 120, y: 100 });
  gestures.end(1);
  expect(camera).toMatchObject({ scale: 2, x: -60, y: -60 });
  expect(positions.get('approve')).toEqual({ x: 100, y: 100 });
  expect(activate).not.toHaveBeenCalled();
});
