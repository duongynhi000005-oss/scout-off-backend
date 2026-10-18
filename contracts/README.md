# Soroban Smart Contracts

This directory contains the Soroban smart contracts powering the ScoutOff decentralized football scouting platform on Stellar.

## Contracts in this Workspace

- **`shared`**: Common types, error codes, and shared utility helpers.
- **`register`**: Player and scout onboarding and identity registration.
- **`progress`**: Milestone submission, validation, and player progression tracking.
- **`subscription`**: Platform subscriptions and access gating.
- **`connection`**: Scout-to-player connection requests, trial offers, and scouting agreements.
- **`player_token`**: Tokenized player scouting representations and rewards.

---

## Shared Contract Error Codes

All workspace contracts share the `Error` enum defined in [`shared/src/errors.rs`](shared/src/errors.rs) (`#[repr(u32)]`):

| Code | Variant | Returned by | Meaning |
| ---: | --- | --- | --- |
| `1` | `AlreadyInitialized` | `initialize` (all contracts) | Contract has already been initialized. |
| `2` | `NotInitialized` | Operational & admin entrypoints (all contracts) | Contract entrypoint was called before `initialize`. |
| `3` | `PlayerNotFound` | `register` (`get_player`, `update_player`, `update_reputation_score`), `connection` (`get_trial_offer`, `respond_to_trial_offer`) | Referenced player ID or trial offer does not exist in storage. |
| `4` | `NotFound` | `progress` (`submit_milestone`, `approve_milestone`) | Caller (`validator`) is not in the validator registry or target resource is missing. |
| `5` | `InvalidInput` | `register`, `progress`, `subscription`, `connection`, `player_token` | Caller-supplied input failed validation (empty URI, invalid pagination bounds, zero amount/supply, unknown milestone/token series, or allowlist full). |
| `6` | `AlreadyVerified` | `progress::approve_milestone`, `player_token::issue_token` | Milestone has already been approved or player tokens have already been issued. |
| `7` | `InsufficientFee` | `subscription` (`purchase_subscription`, `withdraw_fees`) | Fee is non-positive or requested withdrawal exceeds available fee balance. |
| `8` | `NotSubscribed` | `subscription::cancel_subscription` | Scout has no active subscription or the subscription has already been cancelled. |
| `9` | `Unauthorized` | Admin & role-gated entrypoints (all contracts) | Caller is not the authorized admin, updater, or resource owner. |
| `10` | `ContractPaused` | Mutating entrypoints (all contracts) | Contract is currently paused by the admin. |
| `11` | `Overflow` | `subscription`, `player_token` | Checked integer arithmetic overflowed during fee, duration, balance, or dividend calculation. |
| `12` | `InsufficientSupply` | `player_token::buy_token` | Requested token purchase `amount` exceeds remaining unsold supply (`total_supply - sold`). |

---

## Rust Toolchain & Reproducibility

The Rust compiler toolchain for this workspace is pinned via [`rust-toolchain.toml`](rust-toolchain.toml):

```toml
[toolchain]
channel = "1.81.0"
targets = ["wasm32-unknown-unknown"]
components = ["rustfmt", "clippy"]
```

### Why Pinning Matters
In Soroban smart contract development, the compiled WASM bytecode and resulting contract hashes depend directly on the compiler version, optimization passes, and code generation settings. Pinning the toolchain guarantees:
1. **Deterministic WASM Hashes**: Contract bytecode hashes match across contributor machines, CI runners, and mainnet deployments.
2. **Consistent Linting & Checks**: `clippy` and `rustfmt` checks evaluate identically across all development environments.
3. **No Drift**: Avoids silent breaking changes from upstream compiler updates.

---

## Building and Testing

When you run `cargo` commands inside the `contracts/` directory, `rustup` automatically resolves and uses the pinned toolchain defined in `rust-toolchain.toml`.

### 1. Build Contracts (WASM)
```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
```

### 2. Run Unit Tests
Contracts compile to host architectures for native testing:
```bash
cargo test --workspace --lib --target x86_64-unknown-linux-gnu
# Or for macOS (Apple Silicon):
cargo test --workspace --lib --target aarch64-apple-darwin
```

### 3. Run Invariant Fuzz Tests
```bash
cargo test --workspace --tests --target x86_64-unknown-linux-gnu -- invariants
```

---

## How to Update the Toolchain

When upgrading to a new stable Rust toolchain:
1. Update `channel` in [`contracts/rust-toolchain.toml`](rust-toolchain.toml).
2. Update the `toolchain:` input in GitHub Actions workflows:
   - [`.github/workflows/contract-ci.yml`](../.github/workflows/contract-ci.yml)
   - [`.github/workflows/rust.yml`](../.github/workflows/rust.yml)
   - [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
   - [`.github/workflows/soroban-e2e.yml`](../.github/workflows/soroban-e2e.yml)
3. Update references in [`CONTRIBUTING.md`](../CONTRIBUTING.md).
4. Run `cargo test` and `cargo build --release` to verify compilation, test passes, and bytecode stability.
