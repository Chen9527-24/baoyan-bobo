#include "baoyan/edge_controller.hpp"

#include <iostream>

using namespace baoyan::edge;

namespace {
void trace(const char* input, const Controller& controller, const Actions& actions) {
  std::cout << "{\"simulation_only\":true,\"input\":\"" << input
            << "\",\"state\":\"" << name(controller.status().state)
            << "\",\"active_utterance\":" << controller.status().utterance_id << ",\"actions\":[";
  bool first = true;
  for (const auto& action : actions) {
    if (!first) std::cout << ',';
    first = false;
    std::cout << "{\"type\":\"" << name(action.kind) << "\",\"connection\":" << action.turn.connection
              << ",\"session\":" << action.turn.session << ",\"turn\":" << action.turn.turn
              << ",\"utterance_id\":" << action.utterance_id
              << ",\"reason\":\"" << name(action.reason) << "\"}";
  }
  std::cout << "]}\n";
}
}

int main() {
  // Synthetic evidence flag: no microphone or acoustic processor exists here.
  Controller controller({true, 50});
  auto out = controller.networkReady(1); trace("network_ready", controller, out);
  out = controller.wake(controller.status().control_epoch); trace("explicit_start", controller, out);
  const auto first = controller.status().turn;
  out = controller.sessionOpened(first); trace("fake_gateway_opened", controller, out);
  const auto capture = controller.status().capture;
  out = controller.captureStarted(capture); trace("fake_capture_started", controller, out);
  out = controller.speechStarted(capture, 1, SpeechEvidence::NearEndSpeech); trace("fake_user_speech", controller, out);
  out = controller.utteranceEnded(capture, 1); trace("fake_pause", controller, out);
  out = controller.replyStarted(first); trace("fake_reply_started", controller, out);
  out = controller.audioFrame(first, 0); trace("fake_audio_frame", controller, out);
  out = controller.playbackStarted(first); trace("fake_playback_started", controller, out);
  out = controller.speechStarted(capture, 2, SpeechEvidence::UnverifiedActivity); trace("fake_unverified_noise", controller, out);
  out = controller.speechStarted(capture, 2, SpeechEvidence::AecQualifiedNearEnd); trace("fake_qualified_barge_in", controller, out);
  out = controller.audioFrame(first, 1); trace("late_old_frame", controller, out);
  out = controller.utteranceEnded(capture, 1); trace("late_old_utterance_end", controller, out);
  out = controller.speechStarted(capture, 1, SpeechEvidence::AecQualifiedNearEnd); trace("duplicate_old_speech_start", controller, out);
  out = controller.setPhysicalMute(true); trace("physical_mute", controller, out);
  out = controller.networkLost(1); trace("network_lost", controller, out);
  out = controller.networkReady(2); trace("network_reconnected", controller, out);
  out = controller.setPhysicalMute(false); trace("physical_unmute_without_restart", controller, out);
  out = controller.end(); trace("end", controller, out);
}
