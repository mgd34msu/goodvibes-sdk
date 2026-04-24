// Synced from packages/daemon-sdk/src/otlp-protobuf.ts
type WireType = 0 | 1 | 2 | 3 | 4 | 5;

export type OtlpProtobufKind = 'logs' | 'traces' | 'metrics';

class ProtoReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  eof(): boolean {
    return this.offset >= this.bytes.length;
  }

  readField(): { fieldNumber: number; wireType: WireType } {
    const tag = this.readVarint();
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 0x07n) as WireType;
    if (fieldNumber <= 0) throw new Error(`Invalid protobuf field number: ${fieldNumber}`);
    return { fieldNumber, wireType };
  }

  readVarint(): bigint {
    let value = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      const byte = this.readByte();
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7n;
    }
    throw new Error('Invalid protobuf varint');
  }

  readFixed32(): number {
    this.ensure(4);
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4);
    const value = view.getUint32(0, true);
    this.offset += 4;
    return value;
  }

  readFixed64(): bigint {
    this.ensure(8);
    let value = 0n;
    for (let i = 0; i < 8; i++) {
      value |= BigInt(this.bytes[this.offset + i]) << BigInt(i * 8);
    }
    this.offset += 8;
    return value;
  }

  readDouble(): number {
    this.ensure(8);
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8);
    const value = view.getFloat64(0, true);
    this.offset += 8;
    return value;
  }

  readFloat(): number {
    this.ensure(4);
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4);
    const value = view.getFloat32(0, true);
    this.offset += 4;
    return value;
  }

  readLengthDelimited(): Uint8Array {
    const length = Number(this.readVarint());
    if (!Number.isSafeInteger(length) || length < 0) throw new Error(`Invalid protobuf length: ${length}`);
    this.ensure(length);
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  readString(): string {
    return new TextDecoder().decode(this.readLengthDelimited());
  }

  skip(wireType: WireType): void {
    switch (wireType) {
      case 0:
        this.readVarint();
        return;
      case 1:
        this.ensure(8);
        this.offset += 8;
        return;
      case 2: {
        this.readLengthDelimited();
        return;
      }
      case 5:
        this.ensure(4);
        this.offset += 4;
        return;
      default:
        throw new Error(`Unsupported protobuf wire type: ${wireType}`);
    }
  }

  private readByte(): number {
    this.ensure(1);
    return this.bytes[this.offset++];
  }

  private ensure(length: number): void {
    if (this.offset + length > this.bytes.length) {
      throw new Error('Truncated protobuf payload');
    }
  }
}

function readMessage<T>(reader: ProtoReader, wireType: WireType, decode: (bytes: Uint8Array) => T): T | undefined {
  if (wireType !== 2) {
    reader.skip(wireType);
    return undefined;
  }
  return decode(reader.readLengthDelimited());
}

function readString(reader: ProtoReader, wireType: WireType): string | undefined {
  if (wireType !== 2) {
    reader.skip(wireType);
    return undefined;
  }
  return reader.readString();
}

function readBytes(reader: ProtoReader, wireType: WireType): Uint8Array | undefined {
  if (wireType !== 2) {
    reader.skip(wireType);
    return undefined;
  }
  return reader.readLengthDelimited();
}

function readBool(reader: ProtoReader, wireType: WireType): boolean | undefined {
  if (wireType !== 0) {
    reader.skip(wireType);
    return undefined;
  }
  return reader.readVarint() !== 0n;
}

function readNumeric(reader: ProtoReader, wireType: WireType): number | undefined {
  if (wireType === 0) return Number(reader.readVarint());
  if (wireType === 1) return Number(reader.readFixed64());
  if (wireType === 5) return reader.readFixed32();
  reader.skip(wireType);
  return undefined;
}

function readFloating(reader: ProtoReader, wireType: WireType): number | undefined {
  if (wireType === 1) return reader.readDouble();
  if (wireType === 5) return reader.readFloat();
  reader.skip(wireType);
  return undefined;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function readKeyValueArray(target: Record<string, unknown>, reader: ProtoReader, wireType: WireType): void {
  const entry = readMessage(reader, wireType, decodeKeyValue);
  if (!entry) return;
  const current = Array.isArray(target['attributes']) ? target['attributes'] as unknown[] : [];
  current.push(entry);
  target['attributes'] = current;
}

function decodeKeyValue(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const out: Record<string, unknown> = {};
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    switch (fieldNumber) {
      case 1: {
        const value = readString(reader, wireType);
        if (value !== undefined) out['key'] = value;
        break;
      }
      case 2: {
        const value = readMessage(reader, wireType, decodeAnyValue);
        if (value) out['value'] = value;
        break;
      }
      default:
        reader.skip(wireType);
    }
  }
  return out;
}

function decodeAnyValue(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const out: Record<string, unknown> = {};
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    switch (fieldNumber) {
      case 1: {
        const value = readString(reader, wireType);
        if (value !== undefined) out['stringValue'] = value;
        break;
      }
      case 2: {
        const value = readBool(reader, wireType);
        if (value !== undefined) out['boolValue'] = value;
        break;
      }
      case 3: {
        const value = readNumeric(reader, wireType);
        if (value !== undefined) out['intValue'] = String(Math.trunc(value));
        break;
      }
      case 4: {
        const value = readFloating(reader, wireType);
        if (value !== undefined) out['doubleValue'] = value;
        break;
      }
      case 5: {
        const value = readMessage(reader, wireType, decodeArrayValue);
        if (value) out['arrayValue'] = value;
        break;
      }
      case 6: {
        const value = readMessage(reader, wireType, decodeKeyValueList);
        if (value) out['kvlistValue'] = value;
        break;
      }
      case 7: {
        const value = readBytes(reader, wireType);
        if (value) out['bytesValue'] = bytesToBase64(value);
        break;
      }
      default:
        reader.skip(wireType);
    }
  }
  return out;
}

function decodeArrayValue(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const values: unknown[] = [];
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    if (fieldNumber === 1) {
      const value = readMessage(reader, wireType, decodeAnyValue);
      if (value) values.push(value);
    } else {
      reader.skip(wireType);
    }
  }
  return { values };
}

function decodeKeyValueList(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const values: unknown[] = [];
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    if (fieldNumber === 1) {
      const value = readMessage(reader, wireType, decodeKeyValue);
      if (value) values.push(value);
    } else {
      reader.skip(wireType);
    }
  }
  return { values };
}

function decodeResource(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const out: Record<string, unknown> = { attributes: [] };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    switch (fieldNumber) {
      case 1:
        readKeyValueArray(out, reader, wireType);
        break;
      case 2: {
        const value = readNumeric(reader, wireType);
        if (value !== undefined) out['droppedAttributesCount'] = value;
        break;
      }
      default:
        reader.skip(wireType);
    }
  }
  return out;
}

function decodeScope(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const out: Record<string, unknown> = { attributes: [] };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    switch (fieldNumber) {
      case 1: {
        const value = readString(reader, wireType);
        if (value !== undefined) out['name'] = value;
        break;
      }
      case 2: {
        const value = readString(reader, wireType);
        if (value !== undefined) out['version'] = value;
        break;
      }
      case 3:
        readKeyValueArray(out, reader, wireType);
        break;
      case 4: {
        const value = readNumeric(reader, wireType);
        if (value !== undefined) out['droppedAttributesCount'] = value;
        break;
      }
      default:
        reader.skip(wireType);
    }
  }
  return out;
}

function decodeExportTraceServiceRequest(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const resourceSpans: unknown[] = [];
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    if (fieldNumber === 1) {
      const value = readMessage(reader, wireType, decodeResourceSpans);
      if (value) resourceSpans.push(value);
    } else {
      reader.skip(wireType);
    }
  }
  return { resourceSpans };
}

function decodeResourceSpans(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const out: Record<string, unknown> = { scopeSpans: [] };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    switch (fieldNumber) {
      case 1: {
        const value = readMessage(reader, wireType, decodeResource);
        if (value) out['resource'] = value;
        break;
      }
      case 2: {
        const value = readMessage(reader, wireType, decodeScopeSpans);
        if (value) (out['scopeSpans'] as unknown[]).push(value);
        break;
      }
      case 3: {
        const value = readString(reader, wireType);
        if (value !== undefined) out['schemaUrl'] = value;
        break;
      }
      default:
        reader.skip(wireType);
    }
  }
  return out;
}

function decodeScopeSpans(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const out: Record<string, unknown> = { spans: [] };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    switch (fieldNumber) {
      case 1: {
        const value = readMessage(reader, wireType, decodeScope);
        if (value) out['scope'] = value;
        break;
      }
      case 2: {
        const value = readMessage(reader, wireType, decodeSpan);
        if (value) (out['spans'] as unknown[]).push(value);
        break;
      }
      case 3: {
        const value = readString(reader, wireType);
        if (value !== undefined) out['schemaUrl'] = value;
        break;
      }
      default:
        reader.skip(wireType);
    }
  }
  return out;
}

function decodeSpan(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const out: Record<string, unknown> = { attributes: [], events: [], links: [] };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    switch (fieldNumber) {
      case 1: {
        const value = readBytes(reader, wireType);
        if (value) out['traceId'] = bytesToHex(value);
        break;
      }
      case 2: {
        const value = readBytes(reader, wireType);
        if (value) out['spanId'] = bytesToHex(value);
        break;
      }
      case 3: {
        const value = readString(reader, wireType);
        if (value !== undefined) out['traceState'] = value;
        break;
      }
      case 4: {
        const value = readBytes(reader, wireType);
        if (value) out['parentSpanId'] = bytesToHex(value);
        break;
      }
      case 5: {
        const value = readString(reader, wireType);
        if (value !== undefined) out['name'] = value;
        break;
      }
      case 6: {
        const value = readNumeric(reader, wireType);
        if (value !== undefined) out['kind'] = value;
        break;
      }
      case 7: {
        const value = readNumeric(reader, wireType);
        if (value !== undefined) out['startTimeUnixNano'] = value;
        break;
      }
      case 8: {
        const value = readNumeric(reader, wireType);
        if (value !== undefined) out['endTimeUnixNano'] = value;
        break;
      }
      case 9:
        readKeyValueArray(out, reader, wireType);
        break;
      case 10:
      case 12:
      case 14:
      case 16: {
        const key = fieldNumber === 10
          ? 'droppedAttributesCount'
          : fieldNumber === 12
            ? 'droppedEventsCount'
            : fieldNumber === 14
              ? 'droppedLinksCount'
              : 'flags';
        const value = readNumeric(reader, wireType);
        if (value !== undefined) out[key] = value;
        break;
      }
      case 11: {
        const value = readMessage(reader, wireType, decodeSpanEvent);
        if (value) (out['events'] as unknown[]).push(value);
        break;
      }
      case 13: {
        const value = readMessage(reader, wireType, decodeSpanLink);
        if (value) (out['links'] as unknown[]).push(value);
        break;
      }
      case 15: {
        const value = readMessage(reader, wireType, decodeSpanStatus);
        if (value) out['status'] = value;
        break;
      }
      default:
        reader.skip(wireType);
    }
  }
  return out;
}

function decodeSpanEvent(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const out: Record<string, unknown> = { attributes: [] };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    switch (fieldNumber) {
      case 1: {
        const value = readNumeric(reader, wireType);
        if (value !== undefined) out['timeUnixNano'] = value;
        break;
      }
      case 2: {
        const value = readString(reader, wireType);
        if (value !== undefined) out['name'] = value;
        break;
      }
      case 3:
        readKeyValueArray(out, reader, wireType);
        break;
      case 4: {
        const value = readNumeric(reader, wireType);
        if (value !== undefined) out['droppedAttributesCount'] = value;
        break;
      }
      default:
        reader.skip(wireType);
    }
  }
  return out;
}

function decodeSpanLink(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const out: Record<string, unknown> = { attributes: [] };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    switch (fieldNumber) {
      case 1: {
        const value = readBytes(reader, wireType);
        if (value) out['traceId'] = bytesToHex(value);
        break;
      }
      case 2: {
        const value = readBytes(reader, wireType);
        if (value) out['spanId'] = bytesToHex(value);
        break;
      }
      case 3: {
        const value = readString(reader, wireType);
        if (value !== undefined) out['traceState'] = value;
        break;
      }
      case 4:
        readKeyValueArray(out, reader, wireType);
        break;
      case 5: {
        const value = readNumeric(reader, wireType);
        if (value !== undefined) out['droppedAttributesCount'] = value;
        break;
      }
      default:
        reader.skip(wireType);
    }
  }
  return out;
}

function decodeSpanStatus(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const out: Record<string, unknown> = {};
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    switch (fieldNumber) {
      case 1: {
        const value = readString(reader, wireType);
        if (value !== undefined) out['message'] = value;
        break;
      }
      case 2: {
        const value = readNumeric(reader, wireType);
        if (value !== undefined) out['code'] = value;
        break;
      }
      default:
        reader.skip(wireType);
    }
  }
  return out;
}

function decodeExportLogsServiceRequest(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const resourceLogs: unknown[] = [];
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    if (fieldNumber === 1) {
      const value = readMessage(reader, wireType, decodeResourceLogs);
      if (value) resourceLogs.push(value);
    } else {
      reader.skip(wireType);
    }
  }
  return { resourceLogs };
}

function decodeResourceLogs(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const out: Record<string, unknown> = { scopeLogs: [] };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    switch (fieldNumber) {
      case 1: {
        const value = readMessage(reader, wireType, decodeResource);
        if (value) out['resource'] = value;
        break;
      }
      case 2: {
        const value = readMessage(reader, wireType, decodeScopeLogs);
        if (value) (out['scopeLogs'] as unknown[]).push(value);
        break;
      }
      case 3: {
        const value = readString(reader, wireType);
        if (value !== undefined) out['schemaUrl'] = value;
        break;
      }
      default:
        reader.skip(wireType);
    }
  }
  return out;
}

function decodeScopeLogs(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const out: Record<string, unknown> = { logRecords: [] };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    switch (fieldNumber) {
      case 1: {
        const value = readMessage(reader, wireType, decodeScope);
        if (value) out['scope'] = value;
        break;
      }
      case 2: {
        const value = readMessage(reader, wireType, decodeLogRecord);
        if (value) (out['logRecords'] as unknown[]).push(value);
        break;
      }
      case 3: {
        const value = readString(reader, wireType);
        if (value !== undefined) out['schemaUrl'] = value;
        break;
      }
      default:
        reader.skip(wireType);
    }
  }
  return out;
}

function decodeLogRecord(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const out: Record<string, unknown> = { attributes: [] };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    switch (fieldNumber) {
      case 1:
      case 11: {
        const value = readNumeric(reader, wireType);
        if (value !== undefined) out[fieldNumber === 1 ? 'timeUnixNano' : 'observedTimeUnixNano'] = value;
        break;
      }
      case 2:
      case 7:
      case 8: {
        const key = fieldNumber === 2 ? 'severityNumber' : fieldNumber === 7 ? 'droppedAttributesCount' : 'flags';
        const value = readNumeric(reader, wireType);
        if (value !== undefined) out[key] = value;
        break;
      }
      case 3:
      case 12: {
        const value = readString(reader, wireType);
        if (value !== undefined) out[fieldNumber === 3 ? 'severityText' : 'eventName'] = value;
        break;
      }
      case 5: {
        const value = readMessage(reader, wireType, decodeAnyValue);
        if (value) out['body'] = value;
        break;
      }
      case 6:
        readKeyValueArray(out, reader, wireType);
        break;
      case 9:
      case 10: {
        const value = readBytes(reader, wireType);
        if (value) out[fieldNumber === 9 ? 'traceId' : 'spanId'] = bytesToHex(value);
        break;
      }
      default:
        reader.skip(wireType);
    }
  }
  return out;
}

function decodeExportMetricsServiceRequest(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const resourceMetrics: unknown[] = [];
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    if (fieldNumber === 1) {
      const value = readMessage(reader, wireType, decodeResourceMetrics);
      if (value) resourceMetrics.push(value);
    } else {
      reader.skip(wireType);
    }
  }
  return { resourceMetrics };
}

function decodeResourceMetrics(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const out: Record<string, unknown> = { scopeMetrics: [] };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    switch (fieldNumber) {
      case 1: {
        const value = readMessage(reader, wireType, decodeResource);
        if (value) out['resource'] = value;
        break;
      }
      case 2: {
        const value = readMessage(reader, wireType, decodeScopeMetrics);
        if (value) (out['scopeMetrics'] as unknown[]).push(value);
        break;
      }
      case 3: {
        const value = readString(reader, wireType);
        if (value !== undefined) out['schemaUrl'] = value;
        break;
      }
      default:
        reader.skip(wireType);
    }
  }
  return out;
}

function decodeScopeMetrics(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const out: Record<string, unknown> = { metrics: [] };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    switch (fieldNumber) {
      case 1: {
        const value = readMessage(reader, wireType, decodeScope);
        if (value) out['scope'] = value;
        break;
      }
      case 2: {
        const value = readMessage(reader, wireType, decodeMetric);
        if (value) (out['metrics'] as unknown[]).push(value);
        break;
      }
      case 3: {
        const value = readString(reader, wireType);
        if (value !== undefined) out['schemaUrl'] = value;
        break;
      }
      default:
        reader.skip(wireType);
    }
  }
  return out;
}

function decodeMetric(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const out: Record<string, unknown> = {};
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    switch (fieldNumber) {
      case 1:
      case 2:
      case 3: {
        const key = fieldNumber === 1 ? 'name' : fieldNumber === 2 ? 'description' : 'unit';
        const value = readString(reader, wireType);
        if (value !== undefined) out[key] = value;
        break;
      }
      case 5: {
        const value = readMessage(reader, wireType, decodeGauge);
        if (value) out['gauge'] = value;
        break;
      }
      case 7: {
        const value = readMessage(reader, wireType, decodeSum);
        if (value) out['sum'] = value;
        break;
      }
      case 9: {
        const value = readMessage(reader, wireType, decodeHistogram);
        if (value) out['histogram'] = value;
        break;
      }
      case 10: {
        const value = readMessage(reader, wireType, decodeHistogram);
        if (value) out['exponentialHistogram'] = value;
        break;
      }
      case 11: {
        const value = readMessage(reader, wireType, decodeSummary);
        if (value) out['summary'] = value;
        break;
      }
      case 12:
        readKeyValueArray(out, reader, wireType);
        break;
      default:
        reader.skip(wireType);
    }
  }
  return out;
}

function decodeGauge(bytes: Uint8Array): Record<string, unknown> {
  return decodeMetricPoints(bytes, decodeNumberDataPoint, false);
}

function decodeSum(bytes: Uint8Array): Record<string, unknown> {
  return decodeMetricPoints(bytes, decodeNumberDataPoint, true);
}

function decodeHistogram(bytes: Uint8Array): Record<string, unknown> {
  return decodeMetricPoints(bytes, decodeGenericDataPoint, true);
}

function decodeSummary(bytes: Uint8Array): Record<string, unknown> {
  return decodeMetricPoints(bytes, decodeGenericDataPoint, false);
}

function decodeMetricPoints(
  bytes: Uint8Array,
  decodeDataPoint: (bytes: Uint8Array) => Record<string, unknown>,
  hasAggregationTemporality: boolean,
): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const out: Record<string, unknown> = { dataPoints: [] };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    if (fieldNumber === 1) {
      const value = readMessage(reader, wireType, decodeDataPoint);
      if (value) (out['dataPoints'] as unknown[]).push(value);
    } else if (hasAggregationTemporality && fieldNumber === 2) {
      const value = readNumeric(reader, wireType);
      if (value !== undefined) out['aggregationTemporality'] = value;
    } else if (fieldNumber === 3) {
      const value = readBool(reader, wireType);
      if (value !== undefined) out['isMonotonic'] = value;
    } else {
      reader.skip(wireType);
    }
  }
  return out;
}

function decodeNumberDataPoint(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const out: Record<string, unknown> = { attributes: [] };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    switch (fieldNumber) {
      case 2:
      case 3: {
        const value = readNumeric(reader, wireType);
        if (value !== undefined) out[fieldNumber === 2 ? 'startTimeUnixNano' : 'timeUnixNano'] = value;
        break;
      }
      case 4: {
        const value = readFloating(reader, wireType);
        if (value !== undefined) out['asDouble'] = value;
        break;
      }
      case 6: {
        const value = readNumeric(reader, wireType);
        if (value !== undefined) out['asInt'] = String(Math.trunc(value));
        break;
      }
      case 7:
        readKeyValueArray(out, reader, wireType);
        break;
      case 8: {
        const value = readNumeric(reader, wireType);
        if (value !== undefined) out['flags'] = value;
        break;
      }
      default:
        reader.skip(wireType);
    }
  }
  return out;
}

function decodeGenericDataPoint(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const out: Record<string, unknown> = { attributes: [] };
  while (!reader.eof()) {
    const { fieldNumber, wireType } = reader.readField();
    if (fieldNumber === 2 || fieldNumber === 3 || fieldNumber === 4 || fieldNumber === 5 || fieldNumber === 10 || fieldNumber === 11 || fieldNumber === 12) {
      const value = fieldNumber === 5 || fieldNumber === 11 || fieldNumber === 12
        ? readFloating(reader, wireType)
        : readNumeric(reader, wireType);
      if (value !== undefined) {
        out[
          fieldNumber === 2 ? 'startTimeUnixNano'
            : fieldNumber === 3 ? 'timeUnixNano'
              : fieldNumber === 4 ? 'count'
                : fieldNumber === 5 ? 'sum'
                  : fieldNumber === 10 ? 'flags'
                    : fieldNumber === 11 ? 'min'
                      : 'max'
        ] = value;
      }
    } else if (fieldNumber === 9) {
      readKeyValueArray(out, reader, wireType);
    } else {
      reader.skip(wireType);
    }
  }
  return out;
}

export function decodeOtlpProtobuf(kind: OtlpProtobufKind, bytes: Uint8Array): Record<string, unknown> {
  switch (kind) {
    case 'logs':
      return decodeExportLogsServiceRequest(bytes);
    case 'traces':
      return decodeExportTraceServiceRequest(bytes);
    case 'metrics':
      return decodeExportMetricsServiceRequest(bytes);
  }
}
