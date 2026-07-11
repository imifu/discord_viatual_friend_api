import audify from 'audify';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const { RtAudio, RtAudioApi } = audify;

export interface DeviceInfo {
  id: number;
  name: string;
  inputChannels: number;
  outputChannels: number;
  isDefaultInput: boolean;
  isDefaultOutput: boolean;
  sampleRate: number;
}

export interface DeviceListResult {
  inputDevices: DeviceInfo[];
  outputDevices: DeviceInfo[];
}

type RtDeviceInfo = ReturnType<InstanceType<typeof RtAudio>['getDevices']>[number];

function toDeviceInfo(d: RtDeviceInfo): DeviceInfo {
  return {
    id: d.id,
    name: d.name,
    inputChannels: d.inputChannels,
    outputChannels: d.outputChannels,
    isDefaultInput: !!d.isDefaultInput,
    isDefaultOutput: !!d.isDefaultOutput,
    sampleRate: d.preferredSampleRate,
  };
}

/** Enumerates Windows audio devices via WASAPI (through RtAudio/audify), which reliably reports both input and output channel counts per device, unlike DirectShow (capture-only). */
export function listDevices(): DeviceListResult {
  const rtAudio = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
  const devices = rtAudio.getDevices();
  return {
    inputDevices: devices.filter((d) => d.inputChannels > 0).map(toDeviceInfo),
    outputDevices: devices.filter((d) => d.outputChannels > 0).map(toDeviceInfo),
  };
}

function formatEntry(d: DeviceInfo): string {
  const flags = [d.isDefaultInput ? '既定の録音' : undefined, d.isDefaultOutput ? '既定の再生' : undefined]
    .filter(Boolean)
    .join(', ');
  return `- ${d.name}${flags ? ` [${flags}]` : ''} (id=${d.id}, ${d.sampleRate}Hz)`;
}

export function formatDeviceList(result: DeviceListResult): string {
  const lines: string[] = [];
  lines.push('=== 録音(入力)デバイス [GPT_TO_DISCORD_DEVICE用] ===');
  if (result.inputDevices.length === 0) {
    lines.push('(見つかりませんでした)');
  } else {
    for (const d of result.inputDevices) lines.push(formatEntry(d));
  }
  lines.push('');
  lines.push('=== 再生(出力)デバイス [DISCORD_TO_GPT_DEVICE用] ===');
  if (result.outputDevices.length === 0) {
    lines.push('(見つかりませんでした)');
  } else {
    for (const d of result.outputDevices) lines.push(formatEntry(d));
  }
  lines.push('');
  lines.push('※ .envには括弧内を含むフルネーム(例: "CABLE-A Input (VB-Audio Virtual Cable A)")を設定してください。');
  return lines.join('\n');
}

function main(): void {
  const result = listDevices();
  console.log(formatDeviceList(result));
}

const isDirectRun = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  main();
}
