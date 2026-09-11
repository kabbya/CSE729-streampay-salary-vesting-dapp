// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {StreamPay} from "../src/StreamPay.sol";

/**
 * @notice Deploys StreamPay from Anvil Account #0 so that the constructor's
 *         `msg.sender` - and therefore the protocol admin - is Account #0,
 *         exactly as Checkpoint 1 and 2 require.
 *
 * Run with:
 *   forge script script/DeployStreamPay.s.sol:DeployStreamPay \
 *     --rpc-url http://127.0.0.1:8545 --broadcast
 */
contract DeployStreamPay is Script {
    /// @dev Anvil's Account #0 key under the DEFAULT mnemonic
    ///      ("test test test test test test test test test test test junk").
    ///      It is deterministic, published in Foundry's own docs, and worthless.
    ///      NEVER put a real key here and never use this key on a public network.
    uint256 internal constant DEFAULT_ANVIL_KEY =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external returns (StreamPay deployed) {
        // Uses PRIVATE_KEY from .env if set. The public fallback is allowed only
        // on local Anvil, so a missing environment variable cannot fund a public tx.
        uint256 pk = vm.envOr("PRIVATE_KEY", DEFAULT_ANVIL_KEY);
        if (pk == DEFAULT_ANVIL_KEY) {
            require(block.chainid == 31_337, "set PRIVATE_KEY outside local Anvil");
        }
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);
        deployed = new StreamPay();
        vm.stopBroadcast();

        console.log("Deployer / admin :", deployer);
        console.log("StreamPay address:", address(deployed));
        console.log("Admin recorded   :", deployed.admin());
        require(deployed.admin() == deployer, "admin mismatch");
    }
}
