#include "baoyan/edge_controller.hpp"

#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using namespace baoyan::edge;

namespace {
#define CHECK(expression) do { if (!(expression)) throw std::runtime_error( \
  std::string(__FILE__) + ":" + std::to_string(__LINE__) + " " #expression); } while (false)

std::size_t count(const Actions& out, ActionKind kind) {
  std::size_t total = 0;
  for (const auto& action : out) if (action.kind == kind) ++total;
  return total;
}
std::size_t index(const Actions& out, ActionKind kind) {
  for (std::size_t i = 0; i < out.size; ++i) if (out.items[i].kind == kind) return i;
  return out.size;
}
TurnToken listening(Controller& c, std::uint64_t connection = 1) {
  c.networkReady(connection);
  const auto open = c.wake(c.status().control_epoch);
  CHECK(count(open, ActionKind::OpenSession) == 1);
  const auto token = c.status().turn;
  c.sessionOpened(token);
  c.captureStarted(c.status().capture);
  CHECK(c.status().state == State::Listening);
  return token;
}
TurnToken waiting(Controller& c) {
  const auto token = c.status().turn;
  const auto capture = c.status().capture;
  c.speechStarted(capture, token.turn, SpeechEvidence::NearEndSpeech);
  c.utteranceEnded(capture, token.turn);
  CHECK(c.status().state == State::WaitingReply);
  return token;
}
TurnToken speaking(Controller& c) {
  const auto token = waiting(c);
  c.replyStarted(token);
  CHECK(count(c.audioFrame(token, 0), ActionKind::QueueAudioFrame) == 1);
  c.playbackStarted(token);
  CHECK(c.status().state == State::Speaking);
  return token;
}

void startup_requires_network_gateway_and_capture_acks() {
  Controller c;
  CHECK(c.status().state == State::Offline);
  CHECK(c.wake(c.status().control_epoch).size == 0);
  CHECK(c.networkReady(0).size == 0);
  CHECK(count(c.networkReady(1), ActionKind::StartCapture) == 0);
  CHECK(c.status().state == State::Idle);
  const auto start = c.wake(c.status().control_epoch);
  CHECK(c.status().state == State::Connecting);
  CHECK(!c.status().capture_active);
  CHECK(count(start, ActionKind::StartCapture) == 0);
  CHECK(c.wake(c.status().control_epoch).size == 0);
  const auto opened = c.sessionOpened(c.status().turn);
  CHECK(count(opened, ActionKind::StartCapture) == 1);
  CHECK(c.status().state == State::StartingCapture);
  CHECK(c.captureTarget(c.status().capture).session == 0);
  c.captureStarted(c.status().capture);
  CHECK(c.status().state == State::Listening);
  CHECK(c.captureTarget(c.status().capture) == c.status().turn);
}

void silence_and_unverified_activity_cannot_submit_a_turn() {
  Controller c({true, 50});
  listening(c);
  auto cap = c.status().capture;
  CHECK(c.utteranceEnded(cap, 1).size == 0);
  c.speechStarted(cap, 1, SpeechEvidence::UnverifiedActivity);
  CHECK(c.utteranceEnded(cap, 1).size == 0);
  CHECK(c.status().state == State::Listening);
}

void default_half_duplex_releases_microphone_before_output() {
  Controller c;
  listening(c);
  const auto capture = c.status().capture;
  const auto token = waiting(c);
  CHECK(!c.status().capture_active);
  CHECK(!c.status().capture_requested);
  CHECK(c.captureTarget(capture).session == 0);
  c.replyStarted(token);
  c.audioFrame(token, 0);
  c.playbackStarted(token);
  CHECK(c.speechStarted(capture, 2, SpeechEvidence::AecQualifiedNearEnd).size == 0);
  CHECK(c.status().state == State::Speaking);
}

void validated_duplex_keeps_capture_and_stops_playback_before_cancel() {
  Controller c({true, 50});
  listening(c);
  const auto capture = c.status().capture;
  const auto old_turn = speaking(c);
  CHECK(c.status().capture_active);
  const auto out = c.speechStarted(capture, 2, SpeechEvidence::AecQualifiedNearEnd);
  CHECK(out.size >= 3);
  CHECK(out.items[0].kind == ActionKind::StopPlayback);
  CHECK(out.items[1].kind == ActionKind::CancelResponse);
  CHECK(out.items[0].turn == old_turn && out.items[1].turn == old_turn);
  CHECK(count(out, ActionKind::StartCapture) == 0);
  CHECK(count(out, ActionKind::StopCapture) == 0);
  CHECK(c.status().capture == capture);
  CHECK(c.status().capture_active && !c.status().playback_active);
  CHECK(c.status().state == State::Listening);
  CHECK(c.status().turn.turn == old_turn.turn + 1);
  CHECK(c.captureTarget(capture) == c.status().turn);
}

void noise_or_non_aec_speech_never_interrupts_speaker() {
  Controller c({true, 50});
  listening(c);
  const auto capture = c.status().capture;
  const auto token = speaking(c);
  CHECK(c.speechStarted(capture, 2, SpeechEvidence::UnverifiedActivity).size == 0);
  CHECK(c.speechStarted(capture, 2, SpeechEvidence::NearEndSpeech).size == 0);
  CHECK(c.status().state == State::Speaking);
  CHECK(c.status().turn == token);
}

void late_old_reply_and_unidentified_audio_cannot_play_after_barge_in() {
  Controller c({true, 50});
  listening(c);
  const auto old = speaking(c);
  c.speechStarted(c.status().capture, 2, SpeechEvidence::AecQualifiedNearEnd);
  const auto fresh = c.status().turn;
  CHECK(c.audioFrame(old, 1).size == 0);
  CHECK(c.audioFrame({}, 0).size == 0);
  CHECK(c.replyStarted(old).size == 0);
  CHECK(count(c.playbackStarted(old), ActionKind::StopPlayback) == 1);
  CHECK(c.replyEnded(old).size == 0);
  CHECK(c.playbackDrained(old).size == 0);
  c.utteranceEnded(c.status().capture, 2);
  CHECK(c.audioFrame(fresh, 0).size == 0); // Requires a same-turn reply-start.
  c.replyStarted(fresh);
  CHECK(count(c.audioFrame(fresh, 0), ActionKind::QueueAudioFrame) == 1);
}

void audio_frame_order_and_duplicate_checks_preserve_reply() {
  Controller c({true, 50});
  listening(c);
  const auto token = waiting(c);
  c.replyStarted(token);
  CHECK(c.audioFrame(token, 2).size == 0);
  CHECK(count(c.audioFrame(token, 0), ActionKind::QueueAudioFrame) == 1);
  CHECK(c.audioFrame(token, 0).size == 0);
  c.replyStarted(token); // Duplicate must not reset the expected frame index.
  CHECK(count(c.audioFrame(token, 1), ActionKind::QueueAudioFrame) == 1);
  c.replyEnded(token);
  CHECK(c.audioFrame(token, 2).size == 0);
}

void server_eof_does_not_mean_speaker_finished() {
  Controller c({true, 50});
  listening(c);
  const auto token = speaking(c);
  CHECK(c.playbackDrained(token).size == 0);
  c.replyEnded(token);
  CHECK(c.status().playback_active);
  CHECK(c.status().state == State::Speaking);
  CHECK(c.status().turn == token);
  const auto out = c.playbackDrained(token);
  CHECK(c.status().state == State::Listening);
  CHECK(!c.status().playback_active);
  CHECK(c.status().turn.turn == token.turn + 1);
  CHECK(count(out, ActionKind::StartCapture) == 0);
  CHECK(c.playbackDrained(token).size == 0);
}

void half_duplex_resumes_after_local_drain_with_one_turn_start() {
  Controller c;
  listening(c);
  const auto token = speaking(c);
  c.replyEnded(token);
  const auto resumed = c.playbackDrained(token);
  CHECK(count(resumed, ActionKind::StartCapture) == 1);
  CHECK(count(resumed, ActionKind::BeginTurn) == 0);
  CHECK(c.status().state == State::StartingCapture);
  const auto ack = c.captureStarted(c.status().capture);
  CHECK(count(ack, ActionKind::BeginTurn) == 1);
  CHECK(c.status().state == State::Listening);
}

void network_loss_and_reconnect_never_resume_microphone() {
  Controller c({true, 50});
  const auto old = listening(c, 8);
  const auto capture = c.status().capture;
  speaking(c);
  const auto lost = c.networkLost(8);
  CHECK(count(lost, ActionKind::StopCapture) == 1);
  CHECK(count(lost, ActionKind::StopPlayback) == 1);
  CHECK(count(lost, ActionKind::CloseSession) == 1);
  CHECK(c.status().state == State::Offline);
  CHECK(!c.status().capture_active && !c.status().session_open);
  CHECK(c.captureTarget(capture).session == 0);
  CHECK(c.networkReady(8).size == 0);
  const auto ready = c.networkReady(9);
  CHECK(c.status().state == State::Idle);
  CHECK(count(ready, ActionKind::StartCapture) == 0);
  CHECK(count(ready, ActionKind::OpenSession) == 0);
  CHECK(c.audioFrame(old, 0).size == 0);
  CHECK(c.speechStarted(capture, 2, SpeechEvidence::AecQualifiedNearEnd).size == 0);
  c.wake(c.status().control_epoch);
  CHECK(c.status().turn.connection == 9);
  CHECK(c.status().turn.session > old.session);
}

void stale_network_disconnect_cannot_end_new_connection() {
  Controller c({true, 50});
  listening(c, 2);
  const auto replaced = c.networkReady(3);
  CHECK(count(replaced, ActionKind::StopCapture) == 1);
  CHECK(c.status().state == State::Idle);
  CHECK(c.networkLost(2).size == 0);
  CHECK(c.status().network_ready);
  CHECK(c.networkReady(1).size == 0);
}

void physical_mute_has_priority_and_unmute_does_not_reopen() {
  Controller c({true, 50});
  listening(c);
  const auto old = speaking(c);
  const auto cap = c.status().capture;
  const auto muted = c.setPhysicalMute(true);
  CHECK(muted.items[0].kind == ActionKind::SetHardwareMute);
  CHECK(muted.items[0].value == 1);
  CHECK(count(muted, ActionKind::StopCapture) == 1);
  CHECK(index(muted, ActionKind::StopPlayback) < index(muted, ActionKind::CancelResponse));
  CHECK(c.status().state == State::Muted);
  CHECK(c.captureTarget(cap).session == 0);
  CHECK(c.wake(c.status().control_epoch).size == 0);
  CHECK(c.audioFrame(old, 1).size == 0);
  c.networkLost(1);
  c.networkReady(2);
  CHECK(c.status().state == State::Muted);
  const auto unmuted = c.setPhysicalMute(false);
  CHECK(count(unmuted, ActionKind::StartCapture) == 0);
  CHECK(count(unmuted, ActionKind::OpenSession) == 0);
  CHECK(c.status().state == State::Idle);
  CHECK(!c.status().capture_active);
}

void stop_and_end_release_and_reject_late_callbacks() {
  for (const bool complete : {false, true}) {
    Controller c({true, 50});
    const auto token = listening(c);
    const auto cap = c.status().capture;
    speaking(c);
    const auto closed = complete ? c.end() : c.stop();
    CHECK(count(closed, ActionKind::StopCapture) == 1);
    CHECK(count(closed, ActionKind::StopPlayback) == 1);
    CHECK(count(closed, ActionKind::CloseSession) == 1);
    CHECK(c.status().state == State::Stopped);
    CHECK(!c.status().capture_active && !c.status().playback_active);
    CHECK(c.audioFrame(token, 0).size == 0);
    CHECK(count(c.captureStarted(cap), ActionKind::StopCapture) == 1);
    CHECK(count(c.sessionOpened(token), ActionKind::CloseSession) == 1);
    CHECK(count(c.stop(), ActionKind::CloseSession) == 0);
  }
}

void late_capture_start_after_mute_is_released() {
  Controller c;
  c.networkReady(1);
  c.wake(c.status().control_epoch);
  c.sessionOpened(c.status().turn);
  const auto cap = c.status().capture;
  c.setPhysicalMute(true);
  const auto late = c.captureStarted(cap);
  CHECK(count(late, ActionKind::StopCapture) == 1);
  CHECK(count(late, ActionKind::BeginTurn) == 0);
  CHECK(c.status().state == State::Muted);
  CHECK(!c.status().capture_active);
}

void late_output_ack_stops_only_its_old_generation() {
  Controller c({true, 50});
  listening(c);
  const auto old = speaking(c);
  c.speechStarted(c.status().capture, 2, SpeechEvidence::AecQualifiedNearEnd);
  c.utteranceEnded(c.status().capture, 2);
  const auto fresh = c.status().turn;
  c.replyStarted(fresh);
  c.audioFrame(fresh, 0);
  c.playbackStarted(fresh);
  const auto late = c.playbackStarted(old);
  CHECK(late.size == 1 && late.items[0].kind == ActionKind::StopPlayback);
  CHECK(late.items[0].turn == old);
  CHECK(c.status().turn == fresh && c.status().state == State::Speaking);
}

void unsolicited_current_output_fails_closed() {
  Controller c({true, 50});
  const auto token = listening(c);
  const auto unexpected = c.playbackStarted(token);
  CHECK(c.status().state == State::Fault);
  CHECK(count(unexpected, ActionKind::StopPlayback) == 1);
  CHECK(count(unexpected, ActionKind::StopCapture) == 1);
  CHECK(!c.status().capture_active);
}

void late_duplicate_session_ack_cannot_close_current_conversation() {
  Controller c({true, 50});
  const auto first = listening(c);
  const auto token = speaking(c);
  c.replyEnded(token);
  c.playbackDrained(token);
  CHECK(c.status().turn.turn == first.turn + 1);
  CHECK(c.sessionOpened(first).size == 0);
  CHECK(c.status().session_open && c.status().capture_active);
}

void volume_is_bounded_local_and_never_starts_capture() {
  Controller c({false, 400});
  CHECK(c.status().volume == 100);
  CHECK(c.setVolume(120).size == 0);
  const auto low = c.setVolume(-9);
  CHECK(c.status().volume == 0);
  CHECK(low.size == 1 && low.items[0].kind == ActionKind::SetVolume);
  c.setPhysicalMute(true);
  c.setVolume(38);
  CHECK(c.status().volume == 38);
  CHECK(c.status().state == State::Muted);
  CHECK(!c.status().capture_active);
}

void adapter_failure_closes_all_resources_without_retry() {
  Controller c({true, 50});
  const auto token = listening(c);
  const auto out = c.adapterFailed(token);
  CHECK(c.status().state == State::Fault);
  CHECK(count(out, ActionKind::StopCapture) == 1);
  CHECK(count(out, ActionKind::StopPlayback) == 1);
  CHECK(count(out, ActionKind::CloseSession) == 1);
  CHECK(count(out, ActionKind::OpenSession) == 0);
  CHECK(!c.status().capture_active);
  CHECK(c.adapterFailed(token).size == 0);
}

void queued_wake_from_before_stop_mute_or_reconnect_cannot_restart() {
  Controller c;
  c.networkReady(1);
  const auto before_stop = c.status().control_epoch;
  c.stop();
  CHECK(c.wake(before_stop).size == 0);
  const auto before_mute = c.status().control_epoch;
  c.setPhysicalMute(true);
  c.setPhysicalMute(false);
  CHECK(c.wake(before_mute).size == 0);
  const auto before_reconnect = c.status().control_epoch;
  c.networkLost(1);
  c.networkReady(2);
  CHECK(c.wake(before_reconnect).size == 0);
  CHECK(!c.status().capture_requested);
  CHECK(count(c.wake(c.status().control_epoch), ActionKind::OpenSession) == 1);
}

void qualified_barge_in_works_while_reply_is_queued_or_generating() {
  for (const bool queued : {false, true}) {
    Controller c({true, 50});
    listening(c);
    const auto old = waiting(c);
    if (queued) {
      c.replyStarted(old);
      c.audioFrame(old, 0);
    }
    CHECK(!c.status().playback_active);
    const auto interrupted = c.speechStarted(c.status().capture, 2, SpeechEvidence::AecQualifiedNearEnd);
    CHECK(interrupted.items[0].kind == ActionKind::StopPlayback);
    CHECK(interrupted.items[1].kind == ActionKind::CancelResponse);
    CHECK(c.status().turn.turn == old.turn + 1);
    CHECK(c.status().state == State::Listening);
  }
}

void old_utterance_endpoint_cannot_finish_new_barge_in() {
  Controller c({true, 50});
  listening(c);
  const auto cap = c.status().capture;
  const auto old = speaking(c); // Acoustic utterance 1 has already ended.
  c.speechStarted(cap, 2, SpeechEvidence::AecQualifiedNearEnd);
  const auto fresh = c.status().turn;
  CHECK(fresh.turn == old.turn + 1);
  CHECK(c.status().capture == cap);
  CHECK(c.utteranceEnded(cap, 1).size == 0);
  CHECK(c.utteranceEnded(cap, 0).size == 0);
  CHECK(c.utteranceEnded(cap, 3).size == 0);
  CHECK(c.status().state == State::Listening && c.status().utterance_id == 2);
  const auto correct = c.utteranceEnded(cap, 2);
  CHECK(count(correct, ActionKind::UtteranceFinished) == 1);
  CHECK(correct.items[0].turn == fresh && correct.items[0].utterance_id == 2);
  CHECK(c.status().state == State::WaitingReply);
  CHECK(c.utteranceEnded(cap, 2).size == 0);
}

void duplicate_or_old_speech_start_cannot_create_another_turn() {
  Controller c({true, 50});
  listening(c);
  const auto cap = c.status().capture;
  const auto old = speaking(c);
  CHECK(c.speechStarted(cap, 0, SpeechEvidence::AecQualifiedNearEnd).size == 0);
  CHECK(c.speechStarted(cap, 1, SpeechEvidence::AecQualifiedNearEnd).size == 0);
  CHECK(c.status().turn == old && c.status().state == State::Speaking);
  c.speechStarted(cap, 2, SpeechEvidence::AecQualifiedNearEnd);
  const auto fresh = c.status().turn;
  CHECK(c.speechStarted(cap, 1, SpeechEvidence::AecQualifiedNearEnd).size == 0);
  CHECK(c.speechStarted(cap, 2, SpeechEvidence::AecQualifiedNearEnd).size == 0);
  c.utteranceEnded(cap, 2);
  CHECK(c.speechStarted(cap, 2, SpeechEvidence::AecQualifiedNearEnd).size == 0);
  CHECK(c.status().turn == fresh && c.status().state == State::WaitingReply);
}

void completed_turn_retains_acoustic_high_water_mark_on_same_capture() {
  Controller c({true, 50});
  listening(c);
  const auto cap = c.status().capture;
  const auto first = speaking(c);
  c.replyEnded(first);
  c.playbackDrained(first);
  CHECK(c.status().capture == cap);
  CHECK(c.speechStarted(cap, 1, SpeechEvidence::NearEndSpeech).size == 0);
  CHECK(c.utteranceEnded(cap, 1).size == 0);
  CHECK(c.status().state == State::Listening && c.status().utterance_id == 0);
  c.speechStarted(cap, 2, SpeechEvidence::NearEndSpeech);
  CHECK(c.utteranceEnded(cap, 1).size == 0);
  CHECK(count(c.utteranceEnded(cap, 2), ActionKind::UtteranceFinished) == 1);
}

void captured_audio_keeps_its_original_turn_across_upload_queue() {
  Controller c({true, 50});
  listening(c);
  const auto cap = c.status().capture;
  const auto captured_turn = c.captureTarget(cap); // Freeze at capture/enqueue.
  CHECK(c.mayUpload(cap, captured_turn));
  speaking(c);
  c.speechStarted(cap, 2, SpeechEvidence::AecQualifiedNearEnd);
  CHECK(c.status().capture == cap);
  CHECK(!c.mayUpload(cap, captured_turn));
  CHECK(c.mayUpload(cap, c.captureTarget(cap)));
  const auto second = c.captureTarget(cap);
  c.setPhysicalMute(true);
  CHECK(!c.mayUpload(cap, second));
}

void seeded_event_interleavings_preserve_resource_invariants() {
  Controller c({true, 50});
  std::uint64_t random = 0x424f424fULL;
  std::uint64_t connection = 0;
  for (int i = 0; i < 15000; ++i) {
    random ^= random << 13;
    random ^= random >> 7;
    random ^= random << 17;
    const auto before = c.status();
    Actions out;
    switch (random % 16) {
      case 0: out = c.networkReady(++connection); break;
      case 1: out = c.networkLost(connection); break;
      case 2: out = c.wake(c.status().control_epoch); break;
      case 3: out = c.sessionOpened(before.turn); break;
      case 4: out = c.captureStarted(before.capture); break;
      case 5: out = c.speechStarted(before.capture, static_cast<std::uint64_t>(i) + 1, SpeechEvidence::AecQualifiedNearEnd); break;
      case 6: out = c.utteranceEnded(before.capture, before.utterance_id); break;
      case 7: out = c.replyStarted(before.turn); break;
      case 8: out = c.audioFrame(before.turn, 0); break;
      case 9: out = c.playbackStarted(before.turn); break;
      case 10: out = c.replyEnded(before.turn); break;
      case 11: out = c.playbackDrained(before.turn); break;
      case 12: out = c.setPhysicalMute(!before.physical_mute); break;
      case 13: out = c.stop(); break;
      case 14: out = c.adapterFailed(before.turn); break;
      case 15: out = c.setVolume(static_cast<int>(random % 160) - 30); break;
    }
    const auto& after = c.status();
    CHECK(out.size <= Actions::capacity);
    CHECK(after.volume >= 0 && after.volume <= 100);
    CHECK(!after.capture_active || (after.capture_requested && after.session_open &&
          after.network_ready && !after.physical_mute));
    CHECK(!after.playback_active || (after.session_open && after.network_ready && !after.physical_mute));
    if (after.physical_mute || !after.network_ready) {
      CHECK(!after.capture_requested && !after.capture_active && !after.playback_active);
      CHECK(!after.session_open);
    }
    if (count(out, ActionKind::CancelResponse) != 0) {
      CHECK(index(out, ActionKind::StopPlayback) < index(out, ActionKind::CancelResponse));
    }
  }
}
}  // namespace

int main() {
  const std::vector<std::pair<const char*, std::function<void()>>> tests = {
    {"startup_requires_network_gateway_and_capture_acks", startup_requires_network_gateway_and_capture_acks},
    {"silence_and_unverified_activity_cannot_submit_a_turn", silence_and_unverified_activity_cannot_submit_a_turn},
    {"default_half_duplex_releases_microphone_before_output", default_half_duplex_releases_microphone_before_output},
    {"validated_duplex_keeps_capture_and_stops_playback_before_cancel", validated_duplex_keeps_capture_and_stops_playback_before_cancel},
    {"noise_or_non_aec_speech_never_interrupts_speaker", noise_or_non_aec_speech_never_interrupts_speaker},
    {"late_old_reply_and_unidentified_audio_cannot_play_after_barge_in", late_old_reply_and_unidentified_audio_cannot_play_after_barge_in},
    {"audio_frame_order_and_duplicate_checks_preserve_reply", audio_frame_order_and_duplicate_checks_preserve_reply},
    {"server_eof_does_not_mean_speaker_finished", server_eof_does_not_mean_speaker_finished},
    {"half_duplex_resumes_after_local_drain_with_one_turn_start", half_duplex_resumes_after_local_drain_with_one_turn_start},
    {"network_loss_and_reconnect_never_resume_microphone", network_loss_and_reconnect_never_resume_microphone},
    {"stale_network_disconnect_cannot_end_new_connection", stale_network_disconnect_cannot_end_new_connection},
    {"physical_mute_has_priority_and_unmute_does_not_reopen", physical_mute_has_priority_and_unmute_does_not_reopen},
    {"stop_and_end_release_and_reject_late_callbacks", stop_and_end_release_and_reject_late_callbacks},
    {"late_capture_start_after_mute_is_released", late_capture_start_after_mute_is_released},
    {"late_output_ack_stops_only_its_old_generation", late_output_ack_stops_only_its_old_generation},
    {"unsolicited_current_output_fails_closed", unsolicited_current_output_fails_closed},
    {"late_duplicate_session_ack_cannot_close_current_conversation", late_duplicate_session_ack_cannot_close_current_conversation},
    {"volume_is_bounded_local_and_never_starts_capture", volume_is_bounded_local_and_never_starts_capture},
    {"adapter_failure_closes_all_resources_without_retry", adapter_failure_closes_all_resources_without_retry},
    {"queued_wake_from_before_stop_mute_or_reconnect_cannot_restart", queued_wake_from_before_stop_mute_or_reconnect_cannot_restart},
    {"qualified_barge_in_works_while_reply_is_queued_or_generating", qualified_barge_in_works_while_reply_is_queued_or_generating},
    {"old_utterance_endpoint_cannot_finish_new_barge_in", old_utterance_endpoint_cannot_finish_new_barge_in},
    {"duplicate_or_old_speech_start_cannot_create_another_turn", duplicate_or_old_speech_start_cannot_create_another_turn},
    {"completed_turn_retains_acoustic_high_water_mark_on_same_capture", completed_turn_retains_acoustic_high_water_mark_on_same_capture},
    {"captured_audio_keeps_its_original_turn_across_upload_queue", captured_audio_keeps_its_original_turn_across_upload_queue},
    {"seeded_event_interleavings_preserve_resource_invariants", seeded_event_interleavings_preserve_resource_invariants},
  };
  std::size_t passed = 0;
  for (const auto& test : tests) {
    try {
      test.second();
      ++passed;
      std::cout << "PASS " << test.first << '\n';
    } catch (const std::exception& error) {
      std::cerr << "FAIL " << test.first << ": " << error.what() << '\n';
    }
  }
  std::cout << "RESULT " << passed << '/' << tests.size() << " tests passed\n";
  return passed == tests.size() ? 0 : 1;
}
