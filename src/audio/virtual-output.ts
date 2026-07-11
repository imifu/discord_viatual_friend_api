import audify from 'audify';
import { createLogger } from '../utils/logger.js';
import { AudioStreamOpenError, DeviceNotFoundError } from '../utils/errors.js';

const { RtAudio, RtAudioApi, RtAudioFormat } = audify;
type RtAudio = InstanceType<typeof RtAudio>;
/** audify's flags param is typed as required-looking despite being optional; `undefined` crashes the native binding, so we always pass an explicit numeric value ("no flags"). */
const NO_STREAM_FLAGS = 0 as unknown as Parameters<RtAudio['openStream']>[8];

const logger = createLogger('virtual-output');

export interface VirtualOutputHandle {
  write(frame: Buffer): void;
  close(): void;
}

type RtDeviceInfo = ReturnType<RtAudio['getDevices']>[number];

function findOutputDeviceId(rtAudio: RtAudio, deviceName: string): number {
  const devices = rtAudio.getDevices();
  const normalized = deviceName.trim().toLowerCase();
  const isMatch = (d: RtDeviceInfo): boolean => d.outputChannels > 0 && d.name.trim().toLowerCase() === normalized;
  const isPartialMatch = (d: RtDeviceInfo): boolean =>
    d.outputChannels > 0 && d.name.trim().toLowerCase().includes(normalized);

  const match = devices.find(isMatch) ?? devices.find(isPartialMatch);
  if (!match) {
    throw new DeviceNotFoundError(deviceName, 'output');
  }
  return match.id;
}

/**
 * Opens a WASAPI output stream to a named Windows playback device (e.g. a virtual cable's
 * "Input" side) and returns a handle to push raw s16le PCM frames into it.
 */
export function startVirtualOutput(
  deviceName: string,
  sampleRate: number,
  channels: number,
  frameSizeSamples: number,
  onError?: (message: string) => void,
): VirtualOutputHandle {
  const rtAudio = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
  const deviceId = findOutputDeviceId(rtAudio, deviceName);

  try {
    rtAudio.openStream(
      { deviceId, nChannels: channels, firstChannel: 0 },
      null,
      RtAudioFormat.RTAUDIO_SINT16,
      sampleRate,
      frameSizeSamples,
      'discord-to-gpt',
      null,
      null,
      NO_STREAM_FLAGS,
      (type: number, msg: string) => {
        logger.error(`RtAudio出力エラー(device="${deviceName}", type=${type}): ${msg}`);
        onError?.(msg);
      },
    );
    rtAudio.start();
  } catch (err) {
    throw new AudioStreamOpenError(deviceName, 'output', err);
  }
  logger.info(`仮想出力デバイス開始: device="${deviceName}" id=${deviceId}`);

  return {
    write(frame: Buffer): void {
      rtAudio.write(frame);
    },
    close(): void {
      try {
        rtAudio.stop();
        rtAudio.closeStream();
      } catch (err) {
        logger.warn(`仮想出力デバイスの停止中にエラー: device="${deviceName}"`, err);
      }
      logger.info(`仮想出力デバイス停止: device="${deviceName}"`);
    },
  };
}
