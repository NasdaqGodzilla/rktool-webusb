import { createFsWrapper } from './fs-wrapper.js';
import { createUsbAdapter, ROCKCHIP_USB_FILTERS } from './usb-adapter.js';

export function detectRuntime() {
  if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
    return 'browser';
  }

  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    return 'node';
  }

  return 'unknown';
}

export function createPlatformAdapter(options = {}) {
  const runtime = options.runtime || detectRuntime();
  const usbFilters = options.usbFilters || ROCKCHIP_USB_FILTERS;
  const usbAdapter = createUsbAdapter({
    runtime,
    filters: usbFilters,
    nodeUsb: options.nodeUsb,
    loadNodeUsb: options.loadNodeUsb,
    webUsb: options.webUsb,
  });

  function createFileSystem(moduleInstance, fsOptions = {}) {
    return createFsWrapper(moduleInstance, {
      runtime,
      ...fsOptions,
    });
  }

  return {
    runtime,
    usbFilters,
    createFileSystem,
    requestDevice: usbAdapter.requestDevice,
    getDevices: usbAdapter.getDevices,
  };
}
