// WAV export: turns a rendered AudioBuffer into a 16-bit WAV file.

function encodeWav(buffer) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const rate = buffer.sampleRate;
  const bytes = frames * channels * 2;
  const view = new DataView(new ArrayBuffer(44 + bytes));
  const text = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // plain PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, bytes, true);
  const data = [];
  for (let ch = 0; ch < channels; ch++) data.push(buffer.getChannelData(ch));
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const x = Math.max(-1, Math.min(1, data[ch][i]));
      view.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([view], { type: 'audio/wav' });
}

// Loudest sample and average level, in decibels below full scale.
function measureLevels(buffer) {
  let peak = 0;
  let sum = 0;
  let n = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      sum += d[i] * d[i];
      n++;
    }
  }
  const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
  return { peakDb: db(peak), rmsDb: db(Math.sqrt(sum / n)) };
}
