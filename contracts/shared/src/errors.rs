use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Returned when `initialize` is called on a contract that has already been initialized.
    /// Used by `initialize` across `register`, `progress`, `subscription`, `connection`, and `player_token`.
    AlreadyInitialized = 1,
    /// Returned when a contract entrypoint is called before `initialize` has been executed.
    /// Used by all operational and admin entrypoints across all contracts.
    NotInitialized = 2,
    /// Returned when a referenced player ID or trial offer cannot be found in storage.
    /// Used by `register` (`update_player`, `get_player`, `update_reputation_score`) and
    /// `connection` (`get_trial_offer`, `respond_to_trial_offer`).
    PlayerNotFound = 3,
    /// Returned when a required registry entry (such as a validator in the validator registry) is missing.
    /// Used by `progress::submit_milestone` and `progress::approve_milestone`.
    NotFound = 4,
    /// Returned when caller-supplied parameters fail validation (e.g., empty metadata URI, invalid
    /// pagination `start`/`limit`, zero supply/amount, non-existent milestone or token series, or
    /// allowlist capacity exceeded).
    InvalidInput = 5,
    /// Returned when a milestone has already been approved or player tokens have already been issued.
    /// Used by `progress::approve_milestone` and `player_token::issue_token`.
    AlreadyVerified = 6,
    /// Returned when a fee or withdrawal amount is invalid or exceeds the available balance.
    /// Used by `subscription::purchase_subscription` and `subscription::withdraw_fees`.
    InsufficientFee = 7,
    /// Scout has no active subscription (or the subscription has already been
    /// cancelled).  Used by `cancel_subscription` and any access-guard that
    /// requires a live subscription.
    NotSubscribed = 8,
    /// Returned when the caller is not the authorized admin, updater, or resource owner for the action.
    /// Used by admin and role-gated entrypoints across `register`, `progress`, `subscription`,
    /// `connection`, and `player_token`.
    Unauthorized = 9,
    /// Returned when a state-mutating entrypoint is invoked while the contract is paused.
    /// Used by mutating entrypoints across `register`, `progress`, `subscription`, `connection`,
    /// and `player_token`.
    ContractPaused = 10,
    /// Returned when checked integer arithmetic overflows (e.g., fee accumulation, duration
    /// calculation, token balance updates, or dividend payout pagination).
    /// Used by `subscription` and `player_token`.
    Overflow = 11,
    /// Not enough unsold tokens remain to fulfil the requested purchase.
    /// Used by `player_token::buy_token` when `amount` exceeds the player's
    /// remaining supply (`total_supply - sold`).
    InsufficientSupply = 12,
}
