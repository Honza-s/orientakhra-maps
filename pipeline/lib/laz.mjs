// Minimální čtečka LAS/LAZ (formáty 0–10) přes laz-perf (WASM).
import { readFileSync } from 'node:fs';
import { createLazPerf } from 'laz-perf';

let lazPerf;
export async function readLaz(path) {
  lazPerf ??= await createLazPerf();
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const pointOffset = dv.getUint32(96, true);
  const scale = [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)];
  const offset = [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)];
  const fmt = dv.getUint8(104) & 0x3f;

  const filePtr = lazPerf._malloc(buf.byteLength);
  lazPerf.HEAPU8.set(buf, filePtr);
  const laszip = new lazPerf.LASZip();
  laszip.open(filePtr, buf.byteLength);
  const count = laszip.getCount();
  const len = laszip.getPointLength();
  const pt = lazPerf._malloc(len);
  const x = new Float64Array(count), y = new Float64Array(count), z = new Float32Array(count);
  const cls = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    laszip.getPoint(pt);
    const p = new DataView(lazPerf.HEAPU8.buffer, pt, len);
    x[i] = p.getInt32(0, true) * scale[0] + offset[0];
    y[i] = p.getInt32(4, true) * scale[1] + offset[1];
    z[i] = p.getInt32(8, true) * scale[2] + offset[2];
    cls[i] = fmt >= 6 ? p.getUint8(16) : p.getUint8(15) & 31;
  }
  lazPerf._free(pt); laszip.delete(); lazPerf._free(filePtr);
  void pointOffset;
  return { x, y, z, cls, count };
}
