var emulator;

window.onload = function() {
	let [ imageName, width, height ] =
		window.location.hash.substring(1).split(",");
	emulator = new WebDriver(imageName, width | 0, height | 0);
}

function WebDriver(imageName, width, height) {
	// Init callback suitable for passing to `setTimeout`.  This is necessary
	// in order for `this` to resolve correctly within the method body.
	this.$run = this.run.bind(this);

	this._initWidgets(width, height);

	this.disk = [];
	this.keyBuffer = [];
	this.waitMillis = 0;
	this.paused = false;
	this.activeButton = 1;
	this.interclickButton = 0;

	this.startMillis = Date.now();
	emulator = this; // XXX Remove this when `emuInit` gets refactored out
	emuInit(width, height);

	this.screenUpdater = new ScreenUpdater(
		this.screen.getContext("2d"), width, height
	);

	this.diskLoader = new DiskLoader(imageName, this);
}

{
	let $proto = WebDriver.prototype;

	$proto.run = null;

	$proto.clipboard = null;
	$proto.screen = null;

	$proto.activeButton = null;
	$proto.cpuTimeout = null;
	$proto.disk = null;
	$proto.diskLoader = null;
	$proto.interclickButton = null;
	$proto.keyBuffer = null;
	$proto.paused = null;
	$proto.startMillis = null;
	$proto.waitMillis = null;

	$proto.__defineGetter__("tickCount", function() {
		return Date.now() - this.startMillis;
	});

	$proto.reset = function(cold) {
		cpuReset(cold);
		this.resume();
	};

	$proto.resume = function() {
		if (this.cpuTimeout != null) window.clearTimeout(this.cpuTimeout);
		this.cpuTimeout = window.setTimeout(this.$run, 1);
	};

	$proto.run = function()
	{
		if (this.paused) return;
		let now = Date.now();
		for (var i = 0; i < 200000 && this.waitMillis < now; ++i) {
			cpuSingleStep();
		}
		this.cpuTimeout = window.setTimeout(
			this.$run, Math.max(this.waitMillis - Date.now()), 10
		);
	};

	$proto.wait = function(x) {
		if (this.waitMillis === -1) {
			this.waitMillis = 0;
		}
		else {
			this.waitMillis = this.startMillis + x;
		}
	};

	$proto.registerVideo = function(x, y, value) {
		if (y < 0 || x >= this.screen.width) return;
		let base = (y * this.screen.width + x) * 4;
		let { data } = this.screenUpdater.backBuffer;
		for (let i = 0; i < 32; i++) {
			let lit = ((value & (1 << i)) != 0);
			data[base++] = lit ? 0xfd : 0x65;
			data[base++] = lit ? 0xf6 : 0x7b;
			data[base++] = lit ? 0xe3 : 0x83;
			data[base++] = 255;
		}
		this.screenUpdater.mark(x, y);
	};

	$proto.registerMousePosition = function(x, y) {
		let before = this.mouse;

		let after = this.mouse;
		if (0 <= x && x < 4096) after = (after & ~0x00000FFF) | x;
		if (0 <= y && y < 4096) after = (after & ~0x00FFF000) | (y << 12);

		if (before === after) return;

		this.mouse = after;
		this.wait(-1);
		this.resume();
	};

	$proto.registerMouseButton = function(button, down) {
		if (1 <= button && button <= 3) {
			let bit = 1 << (27 - button);
			if (down) {
				this.mouse |= bit;
			}
			else {
				this.mouse &= ~bit;
			}
		}
		this.wait(-1);
		this.resume();
	};

	$proto.registerKey = function(keyCode) {
		this.keyBuffer.push(keyCode << 24);
		this.wait(-1);
		this.resume();
	};

	$proto.hasInput = function() {
		return this.keyBuffer.length > 0;
	};

	$proto.getInputStatus = function() {
		if (!this.hasInput()) return this.mouse;
		return this.mouse | 0x10000000;
	};

	$proto.getKeyCode = function() {
		if (!this.hasInput()) return 0;
		return this.keyBuffer.shift();
	};

	$proto.toggleClipboard = function()
	{
		this.clipboard.style.width = this.screen.width;
		if (this.clipboard.style.visibility == "hidden") {
			this.clipboard.style.visibility = "visible";
			this.clipboard.style.height = 200;
		}
		else {
			this.clipboard.style.visibility = "hidden";
			this.clipboard.style.height = 0;
		}
	};

	$proto._initWidgets = function(width, height) {
	let $ = document.getElementById.bind(document);
	this.buttonBox = $("buttonbox");
	this.clipboard = $("clipboardText");
	this.screen = $("screen");

		this.screen.width = width;
		this.screen.height = height;

		this.screen.addEventListener("mousemove", this, false);

		$ = document.querySelector.bind(document);
		this.clickLeft = $(".mousebtn[data-button='1']");
		this.clickMiddle = $(".mousebtn[data-button='2']");
		this.clickRight = $(".mousebtn[data-button='3']");

		this.buttonBox.addEventListener("mousedown", this, false);
		this.buttonBox.addEventListener("mouseup", this, false);

		this.toggleClipboard();
	};

	// DOM Event handling

	$proto.handleEvent = function(event) {
		switch (event.type) {
			case
				"load": this._onLoad(event);
			break;
			case
				"mousemove": this._onMouseMove(event);
			break;
			case
				"mousedown": this._onMouseButton(event);
			break;
			case
				"mouseup": this._onMouseButton(event);
			break;
			default:
				throw new Error("got event " + event.type);
			break;
		}
	};

	$proto._onLoad = function(event) {
		this.disk = this.diskLoader.contents;
		this.reset(true);
	};

	$proto._onMouseMove = function(event) {
		let { offsetLeft, offsetTop } = this.screen;
		let scrollX = document.body.scrollLeft;
		let scrollY = document.body.scrollTop;
		let x = event.clientX - offsetLeft + scrollX;
		let y = -(event.clientY - offsetTop + scrollY) + this.screen.height - 1;
		this.registerMousePosition(x, y);
	};

	$proto._onMouseButton = function(event) {
		let clickButton = event.target;
		if (event.type === "mousedown") {
			event.preventDefault();
			this.clickLeft.className = "mousebtn";
			this.clickMiddle.className = "mousebtn";
			this.clickRight.className = "mousebtn";

			clickButton.classList.add("active");

			this.activeButton = clickButton.dataset.button;
			this.interClickButton = 0;
		}
		else {
			if (clickButton.dataset.button === this.activeButton) return;
			this.interClickButton = clickButton.dataset.button;
			clickButton.classList.add("interclick");
		}
	};
}

function ScreenUpdater(context, width, height) {
	this.context = context;
	this.backBuffer = context.createImageData(width, height);

	this.clear();
}

{
	let $proto = ScreenUpdater.prototype;

	$proto.backBuffer = null;
	$proto.context = null;
	$proto.maxX = null;
	$proto.maxY = null;
	$proto.minX = null;
	$proto.minY = null;
	$proto.update = null;

	ScreenUpdater.paint = $proto.paint = function(updater) {
		updater.context.putImageData(
			updater.backBuffer, 0, 0, updater.minX, updater.minY,
			updater.maxX - updater.minX + 1, updater.maxY - updater.minY + 1
		);
		updater.clear();
	};

	$proto.mark = function(x, y) {
		if (x < this.minX) this.minX = x;
		if (y < this.minY) this.minY = y;
		if (x > this.maxX) this.maxX = x + 31;
		if (y > this.maxY) this.maxY = y;
		if (!this.update) this.update = window.setTimeout(this.paint, 1, this);
	};

	$proto.clear = function() {
		this.minX = this.minY = 4096;
		this.maxX = this.maxY = 0;
		this.update = null;
	};
}

function DiskLoader(imageName, observer) {
	this.contents = [];
	this.container = new Image();

	this.handleEvent = function(event) {
		let canvas = document.createElement("canvas");
		let width = canvas.width = this.container.width;
		let height = canvas.height = this.container.height;
		let context = canvas.getContext("2d");

		context.drawImage(this.container, 0, 0);
		let { data } = context.getImageData(0, 0, width, height);
		this.read(data, width, height, this.contents);

		observer.handleEvent(event);
	}

	this.container.addEventListener("load", this);
	this.container.src = imageName + ".png";
}

DiskLoader.prototype.read = function(imageData, width, height, contents) {
	for (let i = 0; i < height; i++) {
		let sectorWords = new Int32Array(width / 4);
		for (let j = 0; j < width / 4; j++) {
			let b = i * 4096 + j * 16 + 2;
			sectorWords[j] =
				((imageData[b +  0] & 0xFF) <<  0) |
				((imageData[b +  4] & 0xFF) <<  8) |
				((imageData[b +  8] & 0xFF) << 16) |
				((imageData[b + 12] & 0xFF) << 24) |
				0;
		}
		contents[i] = sectorWords;
	}
};
