// Removes the speaker echo from the mic track of a capture (SAA-218): WebRTC AEC3,
// echo cancellation ONLY, with the tap as the far-end reference. Spawned by
// recorder/transcribe.py, only when the capture's output was the built-in speakers.
//
// Usage: aec <tap-16k.wav> <mic-16k.wav> <out-16k.wav>
//
// Both inputs are the 16 kHz mono 16-bit WAVs transcribe.py writes. The tap is
// zero-padded or truncated to the mic's length and the output has the mic's
// length. AEC3 finds the delay between the tracks itself (measured on 09-28 for
// SAA-218: a reported delay of 4-92 ms, median 20); nothing here aligns them.
//
// Echo cancellation only: AGC and the high-pass filter are off (SAA-218).
//
// One JSON line goes to stdout for transcribe.py to record: what ran, with which
// library, how long it took, and the delay AEC3 reported. No network, ever: the
// tool opens no sockets and reads and writes only the three paths it is given.
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <vector>
#include "api/scoped_refptr.h"
#include <modules/audio_processing/include/audio_processing.h>

#ifndef AEC_LIB_VERSION
#define AEC_LIB_VERSION "unknown"
#endif
#ifndef AEC_LIB_COMMIT
#define AEC_LIB_COMMIT "unknown"
#endif

static const uint32_t kRate = 16000;
static const size_t kBlock = 160;  // 10 ms, AEC3's frame

static bool read_wav(const char* path, std::vector<int16_t>& out) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return false;
  char riff[12];
  f.read(riff, 12);
  if (!f || memcmp(riff, "RIFF", 4) || memcmp(riff + 8, "WAVE", 4)) return false;
  uint16_t bits = 0, ch = 0;
  uint32_t rate = 0;
  while (f) {
    char id[4];
    uint32_t sz;
    f.read(id, 4);
    f.read(reinterpret_cast<char*>(&sz), 4);
    if (!f) break;
    if (!memcmp(id, "fmt ", 4)) {
      std::vector<char> b(sz);
      f.read(b.data(), sz);
      if (sz < 16) return false;
      memcpy(&ch, b.data() + 2, 2);
      memcpy(&rate, b.data() + 4, 4);
      memcpy(&bits, b.data() + 14, 2);
    } else if (!memcmp(id, "data", 4)) {
      if (bits != 16 || ch != 1 || rate != kRate) return false;
      out.resize(sz / 2);
      f.read(reinterpret_cast<char*>(out.data()), out.size() * 2);
      return true;
    } else {
      f.seekg(sz + (sz & 1), std::ios::cur);
    }
  }
  return false;
}

static bool write_wav(const char* path, const std::vector<int16_t>& s) {
  std::ofstream f(path, std::ios::binary);
  if (!f) return false;
  uint32_t dsz = static_cast<uint32_t>(s.size() * 2), riff = 36 + dsz, fmt = 16, br = kRate * 2, rate = kRate;
  uint16_t tag = 1, ch = 1, ba = 2, bits = 16;
  f.write("RIFF", 4);
  f.write(reinterpret_cast<char*>(&riff), 4);
  f.write("WAVEfmt ", 8);
  f.write(reinterpret_cast<char*>(&fmt), 4);
  f.write(reinterpret_cast<char*>(&tag), 2);
  f.write(reinterpret_cast<char*>(&ch), 2);
  f.write(reinterpret_cast<char*>(&rate), 4);
  f.write(reinterpret_cast<char*>(&br), 4);
  f.write(reinterpret_cast<char*>(&ba), 2);
  f.write(reinterpret_cast<char*>(&bits), 2);
  f.write("data", 4);
  f.write(reinterpret_cast<char*>(&dsz), 4);
  f.write(reinterpret_cast<const char*>(s.data()), dsz);
  return static_cast<bool>(f);
}

int main(int argc, char** argv) {
  if (argc != 4) {
    std::cerr << "usage: aec <tap-16k.wav> <mic-16k.wav> <out-16k.wav>\n";
    return 2;
  }
  std::vector<int16_t> tap, mic;
  if (!read_wav(argv[1], tap)) { std::cerr << "aec: cannot read " << argv[1] << " as 16 kHz mono 16-bit WAV\n"; return 1; }
  if (!read_wav(argv[2], mic)) { std::cerr << "aec: cannot read " << argv[2] << " as 16 kHz mono 16-bit WAV\n"; return 1; }

  const size_t mic_n = mic.size(), tap_n = tap.size();
  const size_t padded = ((mic_n + kBlock - 1) / kBlock) * kBlock;
  tap.resize(padded, 0);  // truncates a longer tap, zero-pads a shorter one
  mic.resize(padded, 0);

  auto apm = webrtc::AudioProcessingBuilder().Create();
  webrtc::AudioProcessing::Config c;
  c.echo_canceller.enabled = true;
  c.echo_canceller.mobile_mode = false;
  c.gain_controller1.enabled = false;
  c.gain_controller2.enabled = false;
  c.high_pass_filter.enabled = false;
  apm->ApplyConfig(c);
  webrtc::StreamConfig sc(kRate, 1);

  std::vector<int16_t> out(padded);
  std::vector<double> delays;
  double erle_sum = 0;
  size_t erle_n = 0;
  auto t0 = std::chrono::steady_clock::now();
  for (size_t i = 0; i < padded; i += kBlock) {
    int16_t far[kBlock], near[kBlock];
    memcpy(far, &tap[i], sizeof far);
    memcpy(near, &mic[i], sizeof near);
    apm->ProcessReverseStream(far, sc, sc, far);
    apm->ProcessStream(near, sc, sc, near);
    memcpy(&out[i], near, sizeof near);
    if ((i / kBlock) % 100 == 0) {  // once a second
      auto st = apm->GetStatistics();
      if (st.delay_ms) delays.push_back(*st.delay_ms);
      if (st.echo_return_loss_enhancement) { erle_sum += *st.echo_return_loss_enhancement; erle_n++; }
    }
  }
  double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  out.resize(mic_n);
  if (!write_wav(argv[3], out)) { std::cerr << "aec: cannot write " << argv[3] << "\n"; return 1; }

  std::sort(delays.begin(), delays.end());
  std::printf(
      "{\"library\":{\"name\":\"webrtc-audio-processing\",\"version\":\"%s\",\"commit\":\"%s\"},"
      "\"config\":{\"echo_canceller\":true,\"mobile_mode\":false,\"gain_controller1\":false,"
      "\"gain_controller2\":false,\"high_pass_filter\":false,\"sample_rate\":%u},"
      "\"mic_samples\":%zu,\"tap_samples\":%zu,\"processing_s\":%.3f,"
      "\"delay_ms\":{\"n\":%zu,\"min\":%.0f,\"median\":%.0f,\"max\":%.0f},\"erle_db_mean\":%.1f}\n",
      AEC_LIB_VERSION, AEC_LIB_COMMIT, kRate, mic_n, tap_n, secs, delays.size(),
      delays.empty() ? 0.0 : delays.front(), delays.empty() ? 0.0 : delays[delays.size() / 2],
      delays.empty() ? 0.0 : delays.back(), erle_n ? erle_sum / erle_n : 0.0);
  return 0;
}
