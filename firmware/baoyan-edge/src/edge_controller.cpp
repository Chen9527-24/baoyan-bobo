#include "baoyan/edge_controller.hpp"

#include <algorithm>
#include <cassert>
#include <limits>

namespace baoyan::edge {
namespace {
constexpr auto max_id = std::numeric_limits<std::uint64_t>::max();
}

Controller::Controller(Config config) noexcept : config_(config) {
  status_.volume = std::clamp(config.initial_volume, 0, 100);
}

void Controller::effect(Actions& out, ActionKind kind, Reason reason,
                        TurnToken turn, CaptureToken capture, int value,
                        std::uint64_t sequence, std::uint64_t utterance_id) noexcept {
  assert(out.size < Actions::capacity);
  out.items[out.size++] = {kind, turn, capture, sequence, value, status_.state, reason, utterance_id};
}

void Controller::indicator(Actions& out, State state) noexcept {
  status_.state = state;
  effect(out, ActionKind::SetIndicator);
}

bool Controller::current(TurnToken token) const noexcept {
  return session_requested_ && status_.network_ready && !status_.physical_mute &&
         token.session != 0 && token == status_.turn;
}

bool Controller::current(CaptureToken token) const noexcept {
  return status_.capture_requested && status_.session_open &&
         status_.network_ready && !status_.physical_mute && token.capture != 0 &&
         token == status_.capture;
}

TurnToken Controller::captureTarget(CaptureToken token) const noexcept {
  return current(token) && status_.capture_active ? status_.turn : TurnToken{};
}

bool Controller::mayUpload(CaptureToken token, TurnToken captured_turn) const noexcept {
  return current(token) && status_.capture_active && current(captured_turn);
}

bool Controller::responsePending() const noexcept {
  return status_.state == State::WaitingReply || status_.state == State::ReplyQueued ||
         status_.state == State::Speaking;
}

void Controller::resetReply() noexcept {
  reply_open_ = false;
  reply_input_done_ = false;
  frame_queued_ = false;
  next_frame_ = 0;
  status_.playback_active = false;
}

void Controller::advanceControlEpoch() noexcept {
  if (status_.control_epoch == max_id) wake_locked_ = true;
  else ++status_.control_epoch;
}

void Controller::releaseCapture(Actions& out, Reason reason) noexcept {
  if (status_.capture_requested) {
    effect(out, ActionKind::StopCapture, reason, status_.turn, status_.capture);
  }
  status_.capture_requested = false;
  status_.capture_active = false;
  status_.capture = {};
}

void Controller::releaseSession(Actions& out, Reason reason) noexcept {
  // Local resource release never waits for a cancellation acknowledgement.
  releaseCapture(out, reason);
  if (session_requested_) {
    effect(out, ActionKind::StopPlayback, reason, status_.turn);
    effect(out, ActionKind::CancelResponse, reason, status_.turn);
    effect(out, ActionKind::CloseSession, reason, status_.turn);
  }
  session_requested_ = false;
  status_.session_open = false;
  status_.turn = {};
  utterance_has_speech_ = false;
  status_.utterance_id = 0;
  resetReply();
}

void Controller::requestCapture(Actions& out) noexcept {
  if (capture_counter_ == max_id) {
    releaseSession(out, Reason::CounterExhausted);
    indicator(out, State::Fault);
    return;
  }
  status_.capture = {status_.turn.connection, status_.turn.session, ++capture_counter_};
  highest_utterance_id_ = 0;
  status_.utterance_id = 0;
  status_.capture_requested = true;
  status_.capture_active = false;
  effect(out, ActionKind::StartCapture, Reason::None, status_.turn, status_.capture);
  indicator(out, State::StartingCapture);
}

bool Controller::nextTurn(Actions& out, Reason reason) noexcept {
  if (status_.turn.turn == max_id) {
    releaseSession(out, Reason::CounterExhausted);
    indicator(out, State::Fault);
    return false;
  }
  ++status_.turn.turn;
  resetReply();
  utterance_has_speech_ = false;
  status_.utterance_id = 0;
  if (status_.capture_active) {
    effect(out, ActionKind::BeginTurn, reason, status_.turn, status_.capture);
  }
  return true;
}

Actions Controller::networkReady(std::uint64_t connection_id) noexcept {
  Actions out;
  // A reconnect is a new transport identity, never reuse an old connection ID.
  if (connection_id == 0 || connection_id <= highest_connection_) return out;
  advanceControlEpoch();
  if (session_requested_) releaseSession(out, Reason::ConnectionReplaced);
  highest_connection_ = connection_id;
  status_.network_ready = true;
  // This only permits a future explicit wake; never turns on the microphone.
  indicator(out, status_.physical_mute ? State::Muted : State::Idle);
  return out;
}

Actions Controller::networkLost(std::uint64_t connection_id) noexcept {
  Actions out;
  if (!status_.network_ready || connection_id != highest_connection_) return out;
  advanceControlEpoch();
  releaseSession(out, Reason::NetworkLost);
  status_.network_ready = false;
  indicator(out, status_.physical_mute ? State::Muted : State::Offline);
  return out;
}

Actions Controller::wake(std::uint64_t observed_control_epoch) noexcept {
  Actions out;
  if (status_.physical_mute || !status_.network_ready || session_requested_ ||
      wake_locked_ || observed_control_epoch != status_.control_epoch) return out;
  if (session_counter_ == max_id) {
    indicator(out, State::Fault);
    return out;
  }
  status_.turn = {highest_connection_, ++session_counter_, 1};
  session_requested_ = true;
  resetReply();
  effect(out, ActionKind::OpenSession, Reason::None, status_.turn);
  indicator(out, State::Connecting);
  return out;
}

Actions Controller::sessionOpened(TurnToken token) noexcept {
  Actions out;
  if (!current(token) || status_.session_open || status_.state != State::Connecting) {
    // A late opening must be closed, but do not close an already active duplicate.
    if (token.session != 0 && (token.connection != status_.turn.connection ||
                              token.session != status_.turn.session)) {
      effect(out, ActionKind::CloseSession, Reason::ExplicitStop, token);
    }
    return out;
  }
  status_.session_open = true;
  requestCapture(out);
  return out;
}

Actions Controller::captureStarted(CaptureToken token) noexcept {
  Actions out;
  if (!current(token)) {
    if (token.capture != 0) {
      // The adapter may finish opening a device after stop/mute; release that handle.
      effect(out, ActionKind::StopCapture, Reason::ExplicitStop, {}, token);
    }
    return out;
  }
  if (status_.capture_active) return out;
  status_.capture_active = true;
  effect(out, ActionKind::BeginTurn, Reason::None, status_.turn, status_.capture);
  indicator(out, State::Listening);
  return out;
}

Actions Controller::speechStarted(CaptureToken token, std::uint64_t utterance_id,
                                  SpeechEvidence evidence) noexcept {
  Actions out;
  if (!current(token) || !status_.capture_active ||
      evidence == SpeechEvidence::UnverifiedActivity || utterance_id == 0 ||
      utterance_id <= highest_utterance_id_) return out;
  if (status_.state == State::Listening) {
    utterance_has_speech_ = true;
    highest_utterance_id_ = utterance_id;
    status_.utterance_id = utterance_id;
    return out;
  }
  if (!responsePending() || !config_.board_duplex_validated ||
      evidence != SpeechEvidence::AecQualifiedNearEnd) return out;

  const auto previous = status_.turn;
  // MUST be applied first: flush speaker/DMA/decoder queues before any network I/O.
  effect(out, ActionKind::StopPlayback, Reason::QualifiedSpeech, previous);
  effect(out, ActionKind::CancelResponse, Reason::QualifiedSpeech, previous);
  if (nextTurn(out, Reason::QualifiedSpeech)) {
    utterance_has_speech_ = true;
    highest_utterance_id_ = utterance_id;
    status_.utterance_id = utterance_id;
    indicator(out, State::Listening);
  }
  return out;
}

Actions Controller::utteranceEnded(CaptureToken token, std::uint64_t utterance_id) noexcept {
  Actions out;
  if (!current(token) || !status_.capture_active || status_.state != State::Listening ||
      !utterance_has_speech_ || utterance_id == 0 || utterance_id != status_.utterance_id) return out;
  utterance_has_speech_ = false;
  status_.utterance_id = 0;
  effect(out, ActionKind::UtteranceFinished, Reason::None, status_.turn, status_.capture,
         0, 0, utterance_id);
  if (!config_.board_duplex_validated) releaseCapture(out, Reason::Completed);
  indicator(out, State::WaitingReply);
  return out;
}

Actions Controller::replyStarted(TurnToken token) noexcept {
  Actions out;
  if (!current(token) || status_.state != State::WaitingReply || reply_open_) return out;
  reply_open_ = true;
  reply_input_done_ = false;
  next_frame_ = 0;
  return out;
}

Actions Controller::audioFrame(TurnToken token, std::uint64_t sequence) noexcept {
  Actions out;
  if (!current(token) || !reply_open_ || reply_input_done_ || !responsePending() ||
      sequence != next_frame_ || next_frame_ == max_id) return out;
  ++next_frame_;
  frame_queued_ = true;
  effect(out, ActionKind::QueueAudioFrame, Reason::None, token, {}, 0, sequence);
  if (!status_.playback_active) indicator(out, State::ReplyQueued);
  return out;
}

Actions Controller::playbackStarted(TurnToken token) noexcept {
  Actions out;
  if (!current(token)) {
    if (token.session != 0) effect(out, ActionKind::StopPlayback, Reason::ExplicitStop, token);
    return out;
  }
  if (!reply_open_ || !frame_queued_ || !responsePending()) {
    // An adapter must not start an output handle before the core accepted audio.
    advanceControlEpoch();
    releaseSession(out, Reason::AdapterFailure);
    indicator(out, State::Fault);
    return out;
  }
  if (status_.playback_active) return out;
  status_.playback_active = true;
  indicator(out, State::Speaking);
  return out;
}

Actions Controller::replyEnded(TurnToken token) noexcept {
  Actions out;
  if (!current(token) || !reply_open_ || !responsePending()) return out;
  // Network EOF is not audible completion; wait for the local renderer's ACK.
  reply_input_done_ = true;
  return out;
}

Actions Controller::playbackDrained(TurnToken token) noexcept {
  Actions out;
  if (!current(token) || !reply_open_ || !reply_input_done_ || !responsePending()) return out;
  if (!nextTurn(out, Reason::Completed)) return out;
  if (!status_.capture_active) requestCapture(out);
  else indicator(out, State::Listening);
  return out;
}

Actions Controller::stop() noexcept {
  Actions out;
  advanceControlEpoch();
  releaseSession(out, Reason::ExplicitStop);
  indicator(out, status_.physical_mute ? State::Muted : State::Stopped);
  return out;
}

Actions Controller::end() noexcept {
  Actions out;
  advanceControlEpoch();
  releaseSession(out, Reason::Completed);
  indicator(out, status_.physical_mute ? State::Muted : State::Stopped);
  return out;
}

Actions Controller::setPhysicalMute(bool muted) noexcept {
  Actions out;
  if (muted == status_.physical_mute) return out;
  advanceControlEpoch();
  status_.physical_mute = muted;
  effect(out, ActionKind::SetHardwareMute, muted ? Reason::PhysicalMute : Reason::None,
         {}, {}, muted ? 1 : 0);
  if (muted) {
    releaseSession(out, Reason::PhysicalMute);
    indicator(out, State::Muted);
  } else {
    // Unmuting grants no implicit consent to restart a previous conversation.
    indicator(out, status_.network_ready ? State::Idle : State::Offline);
  }
  return out;
}

Actions Controller::setVolume(int percent) noexcept {
  Actions out;
  const int clamped = std::clamp(percent, 0, 100);
  if (clamped == status_.volume) return out;
  status_.volume = clamped;
  effect(out, ActionKind::SetVolume, Reason::None, {}, {}, clamped);
  return out;
}

Actions Controller::adapterFailed(TurnToken token) noexcept {
  Actions out;
  if (!current(token)) return out;
  advanceControlEpoch();
  releaseSession(out, Reason::AdapterFailure);
  indicator(out, State::Fault);
  return out;
}

const char* name(State state) noexcept {
  switch (state) {
    case State::Offline: return "offline";
    case State::Idle: return "idle";
    case State::Connecting: return "connecting";
    case State::StartingCapture: return "starting_capture";
    case State::Listening: return "listening";
    case State::WaitingReply: return "waiting_reply";
    case State::ReplyQueued: return "reply_queued";
    case State::Speaking: return "speaking";
    case State::Stopped: return "stopped";
    case State::Muted: return "muted";
    case State::Fault: return "fault";
  }
  return "unknown";
}

const char* name(ActionKind kind) noexcept {
  switch (kind) {
    case ActionKind::OpenSession: return "open_session";
    case ActionKind::CloseSession: return "close_session";
    case ActionKind::StartCapture: return "start_capture";
    case ActionKind::StopCapture: return "stop_capture";
    case ActionKind::BeginTurn: return "begin_turn";
    case ActionKind::UtteranceFinished: return "utterance_finished";
    case ActionKind::QueueAudioFrame: return "queue_audio_frame";
    case ActionKind::StopPlayback: return "stop_playback";
    case ActionKind::CancelResponse: return "cancel_response";
    case ActionKind::SetVolume: return "set_volume";
    case ActionKind::SetHardwareMute: return "set_hardware_mute";
    case ActionKind::SetIndicator: return "set_indicator";
  }
  return "unknown";
}

const char* name(Reason reason) noexcept {
  switch (reason) {
    case Reason::None: return "none";
    case Reason::ExplicitStop: return "explicit_stop";
    case Reason::Completed: return "completed";
    case Reason::NetworkLost: return "network_lost";
    case Reason::ConnectionReplaced: return "connection_replaced";
    case Reason::PhysicalMute: return "physical_mute";
    case Reason::AdapterFailure: return "adapter_failure";
    case Reason::QualifiedSpeech: return "qualified_speech";
    case Reason::CounterExhausted: return "counter_exhausted";
  }
  return "unknown";
}
}  // namespace baoyan::edge
