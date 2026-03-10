import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRKDevelopToolWrapper } from '../../src/rkdeveloptool-wrapper.js';

test('node real ld command with USB device support', async () => {
	const wrapper = await createRKDevelopToolWrapper({
		runtime: 'node',
		onStdout: (line) => {
		process.stdout.write(`${line}\n`);
		},
		onStderr: (line) => {
		process.stderr.write(`${line}\n`);
		},
		onLogWrite: (line) => {
		process.stdout.write(`Log: ${line}\n`);
		},
	});

	try {
		const result = await wrapper.runCommand(['ld'], { requestDevice: true });
		assert.ok(result !== undefined, 'Command should return a result');
	} catch (error) {
		if (error instanceof Error && error.name === "NotFoundError") {
			//ignore this error since it means no device is connected, it's normal
		} else {
			throw error;
		}
	}
});
