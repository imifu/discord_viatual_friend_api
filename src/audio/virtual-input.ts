import audify from 'audify';
import { PassThrough } from 'node:stream';
import { createLogger } from '../utils/logger.js';
import { AudioStreamOpenError, DeviceNotFoundError } from '../utils/errors.js';

const { RtAudio, RtAudioApi, RtAudioFormat } = audify;
type RtAudio = InstanceType<typeof RtAudio>;
/** audify's flags param is typed as required-looking despite being optional; `undefined` crashes the native binding, so we always pass an explicit numeric value ("no flags"). */
const NO_STREAM_FLAGS = 0 as unknown as Parameters<RtAudio['openStream']>[8];

const logger = createLogger('virtual-input');

export interface VirtualInputHandle {
  /** Continuous raw s16le PCM read from the device, suitable for @discordjs/voice's StreamType.Raw. */
  stream: PassThrough;
  close(): void;
}

type RtDeviceInfo = ReturnType<RtAudio['getDevices']>[number];

function findInputDeviceId(rtAudio: RtAudio, deviceName: string): number {
  const devices = rtAudio.getDevices();
  const normalized = deviceName.trim().toLowerCase();
  const isMatch = (d: RtDeviceInfo): boolean => d.inputChannels > 0 && d.name.trim().toLowerCase() === normalized;
  const isPartialMatch = (d: RtDeviceInfo): boolean =>
    d.inputChannels > 0 && d.name.trim().toLowerCase().includes(normalized);

  const match = devices.find(isMatch) ?? devices.find(isPartialMatch);
  if (!match) {
    throw new DeviceNotFoundError(deviceName, 'input');
  }
  return match.id;
}

/**
 * Opens a WASAPI input stream from a named Windows recording device (e.g. a virtual cable's
 * "Output" side) and returns a handle exposing the captured audio as a readable PCM stream.
 */
export function startVirtualInput(
  deviceName: string,
  sampleRate: number,
  channels: number,
  frameSizeSamples: number,
  onError?: (message: string) => void,
): VirtualInputHandle {
  const rtAudio = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
  const deviceId = findInputDeviceId(rtAudio, deviceName);
  const stream = new PassThrough({ highWaterMark: 1 << 20 });

  try {
    rtAudio.openStream(
      null,
      { deviceId, nChannels: channels, firstChannel: 0 },
      RtAudioFormat.RTAUDIO_SINT16,
      sampleRate,
      frameSizeSamples,
      'gpt-to-discord',
      (pcm: Buffer) => {
        if (!stream.destroyed) stream.write(pcm);
      },
      null,
      NO_STREAM_FLAGS,
      (type: number, msg: string) => {
        logger.error(`RtAudio入力エラー(device="${deviceName}", type=${type}): ${msg}`);
        onError?.(msg);
      },
    );
    rtAudio.start();
  } catch (err) {
    throw new AudioStreamOpenError(deviceName, 'input', err);
  }
  logger.info(`仮想入力デバイス開始: device="${deviceName}" id=${deviceId}`);

  return {
    stream,
    close(): void {
      try {
        rtAudio.stop();
        rtAudio.closeStream();
      } catch (err) {
        logger.warn(`仮想入力デバイスの停止中にエラー: device="${deviceName}"`, err);
      }
      stream.end();
      logger.info(`仮想入力デバイス停止: device="${deviceName}"`);
    },
  };
}
