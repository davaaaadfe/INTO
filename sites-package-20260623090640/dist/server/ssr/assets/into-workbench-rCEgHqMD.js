import { a as require_react, o as __toESM, t as require_jsx_runtime } from "../index.js";
//#region components/into-workbench.tsx
var import_react = /* @__PURE__ */ __toESM(require_react(), 1);
var import_jsx_runtime = require_jsx_runtime();
var previewFitModeLabels = {
	auto: "Auto-fit",
	width: "Fit width",
	height: "Fit height",
	manual: "Manual zoom"
};
var acceptedExtensions = new Set([
	"pdf",
	"jpg",
	"jpeg",
	"png",
	"xml",
	"ubl"
]);
var acceptedLabel = "PDF, JPG, PNG, XML, UBL";
var defaultArchiveFilters = {
	keyword: "",
	invoiceDateFrom: "",
	invoiceDateTo: "",
	uploadedAtFrom: "",
	uploadedAtTo: "",
	supplier: "",
	amountMin: "",
	amountMax: "",
	currency: "",
	invoiceNumber: "",
	bookingStatus: "",
	validationStatus: "",
	source: "",
	uploadedByUserId: "",
	exactBookingReference: "",
	journal: "",
	glAccount: "",
	vatCode: "",
	costCenter: "",
	costUnit: "",
	country: "",
	duplicateStatus: "",
	sortBy: "uploadedAt",
	sortDirection: "desc",
	page: 1,
	pageSize: 10
};
var statusTone = {
	Uploaded: "border-stone-300 bg-stone-100 text-stone-700",
	Reading: "border-sky-200 bg-sky-50 text-sky-800",
	"Validation Failed": "border-amber-300 bg-amber-50 text-amber-900",
	"Attachment Missing": "border-rose-300 bg-rose-50 text-rose-800",
	"Supplier Review Required": "border-orange-300 bg-orange-50 text-orange-900",
	"Payment Condition Review Required": "border-yellow-300 bg-yellow-50 text-yellow-900",
	"Booking Intelligence Review Required": "border-violet-300 bg-violet-50 text-violet-900",
	"Possible Duplicate": "border-fuchsia-300 bg-fuchsia-50 text-fuchsia-900",
	"Ready to Book": "border-emerald-300 bg-emerald-50 text-emerald-800",
	Booked: "border-teal-300 bg-teal-50 text-teal-800",
	"Booking Failed": "border-rose-300 bg-rose-50 text-rose-800"
};
var reviewStatuses = new Set([
	"Validation Failed",
	"Attachment Missing",
	"Supplier Review Required",
	"Payment Condition Review Required",
	"Booking Intelligence Review Required",
	"Possible Duplicate",
	"Booking Failed"
]);
var fieldLabels = {
	supplierName: "Extracted supplier",
	supplierVatNumber: "Supplier VAT number",
	supplierChamberOfCommerceNumber: "Chamber of Commerce",
	supplierAddress: "Supplier address",
	supplierCountry: "Supplier country",
	invoiceNumber: "Invoice number",
	referenceCode: "Your ref.",
	invoiceDate: "Invoice date",
	dueDate: "Due date",
	paymentTerms: "Payment terms",
	currency: "Currency",
	netAmount: "Net amount",
	vatAmount: "VAT amount",
	grossAmount: "Total amount",
	iban: "IBAN",
	expenseDescription: "Expense description",
	beneficiary: "Beneficiary",
	serviceStartDate: "Benefit start date",
	serviceEndDate: "Benefit end date",
	companyVatNumber: "Company VAT number"
};
var confidenceLabels = {
	supplierMatch: "Supplier",
	glAccount: "G/L account",
	vatCode: "VAT code",
	costCentre: "Cost center",
	costUnit: "Cost unit",
	paymentCondition: "Payment",
	overall: "Overall"
};
function displayStatus(status) {
	if (status === "Validation Failed") return "Need check";
	if (status === "Booking Intelligence Review Required") return "Intelligence review";
	if (status === "Possible Duplicate") return "Possible duplicate";
	return status;
}
function formatMoney(amount, currency = "EUR") {
	if (typeof amount !== "number") return "-";
	return new Intl.NumberFormat("en-NL", {
		style: "currency",
		currency
	}).format(amount);
}
function money(invoice) {
	return formatMoney(invoice.extractedData.grossAmount, invoice.extractedData.currency || "EUR");
}
function formatFileSize(size) {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
function formatTimestamp(value) {
	if (!value) return "Not synced";
	return new Intl.DateTimeFormat("en-NL", {
		dateStyle: "medium",
		timeStyle: "short"
	}).format(new Date(value));
}
function numberValue(value) {
	return typeof value === "number" ? String(value) : "";
}
function percentScore(value) {
	return `${Math.round(value * 100)}%`;
}
function confidenceTone(value, threshold) {
	return value >= threshold ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900";
}
function fileExtension(fileName) {
	return fileName.split(".").pop()?.toLowerCase() ?? "";
}
function isAcceptedFile(file) {
	return acceptedExtensions.has(fileExtension(file.name));
}
async function checksumFile(file) {
	const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
	return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
function uploadWithProgress(formData, onProgress) {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("POST", "/api/invoices");
		xhr.upload.onprogress = (event) => {
			if (event.lengthComputable) onProgress(event.loaded / event.total);
		};
		xhr.onload = () => {
			const data = JSON.parse(xhr.responseText || "{}");
			if (xhr.status >= 400) {
				reject(new Error(data.error ?? "Upload failed."));
				return;
			}
			resolve(data);
		};
		xhr.onerror = () => reject(/* @__PURE__ */ new Error("Upload failed."));
		xhr.send(formData);
	});
}
function ActionButton({ children, onClick, type = "button", variant = "primary", disabled = false, disabledReason = "", loading = false, feedback, className = "" }) {
	const blocked = disabled || loading;
	const visualState = loading ? "loading" : feedback ?? (disabled ? "disabled" : "enabled");
	const base = "inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-70";
	const pointer = blocked ? "cursor-not-allowed" : "cursor-pointer";
	const stateClasses = {
		enabled: {
			primary: "bg-[#12674f] text-white hover:bg-[#0d503d]",
			secondary: "bg-[#27343a] text-white hover:bg-[#1b2529]",
			outline: "border border-emerald-700 bg-white text-emerald-800 hover:bg-emerald-50",
			danger: "border border-rose-700 bg-white text-rose-800 hover:bg-rose-50",
			ghost: "border border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
		}[variant],
		disabled: "border border-stone-300 bg-stone-100 text-stone-400",
		loading: "bg-stone-700 text-white",
		success: "border border-emerald-500 bg-emerald-100 text-emerald-900",
		error: "border border-rose-400 bg-rose-50 text-rose-800"
	};
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
		className: "inline-flex flex-col",
		title: blocked ? disabledReason : "",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
			type,
			onClick,
			disabled: blocked,
			"aria-disabled": blocked,
			className: `${base} ${pointer} ${stateClasses[visualState]} ${className}`,
			children: [loading ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" }) : null, children]
		})
	});
}
function UploadProgressList({ items }) {
	if (!items.length) return null;
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "mt-4 grid gap-2",
		children: items.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: `rounded-md border px-3 py-2 text-sm ${item.status === "error" ? "border-rose-200 bg-rose-50" : item.status === "duplicate" ? "border-fuchsia-200 bg-fuchsia-50" : item.status === "success" ? "border-emerald-200 bg-emerald-50" : "border-stone-200 bg-stone-50"}`,
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-start justify-between gap-3",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "font-semibold",
					children: item.fileName
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "text-xs text-stone-500",
					children: [
						formatFileSize(item.fileSize),
						" - ",
						item.message
					]
				})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "text-xs font-semibold",
					children: [item.progress, "%"]
				})]
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "mt-2 h-2 overflow-hidden rounded-full bg-stone-200",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: `h-full rounded-full ${item.status === "error" ? "bg-rose-500" : item.status === "duplicate" ? "bg-fuchsia-500" : "bg-[#12674f]"}`,
					style: { width: `${item.progress}%` }
				})
			})]
		}, item.id))
	});
}
function PreviewDocument({ invoice, zoom, rotation, page, fitMode, fullscreen }) {
	const sourceUrl = `/api/invoices/${invoice.id}/file`;
	const previewType = invoice.fileType;
	const isImage = previewType.startsWith("image/") || [
		"jpg",
		"jpeg",
		"png"
	].includes(fileExtension(invoice.fileName));
	const framedSourceUrl = previewType === "application/pdf" || fileExtension(invoice.fileName) === "pdf" ? `${sourceUrl}#page=${page}&toolbar=0&navpanes=0&zoom=${fitMode === "width" ? "page-width" : fitMode === "height" ? "page-fit" : "page-fit"}` : sourceUrl;
	const style = {
		transform: `scale(${zoom}) rotate(${rotation}deg)`,
		transformOrigin: "center top"
	};
	const maxPreviewHeight = fullscreen ? "max-h-[calc(100vh-230px)]" : "max-h-[760px]";
	const fixedPreviewHeight = fullscreen ? "h-[calc(100vh-230px)]" : "h-[760px]";
	const baseFrame = "rounded-md border border-stone-300 bg-white shadow-sm transition-transform";
	const imageSizing = {
		auto: `max-w-full ${maxPreviewHeight} object-contain`,
		width: "h-auto w-full max-w-none",
		height: `${maxPreviewHeight} w-auto max-w-none`,
		manual: "h-auto max-w-none"
	};
	const pdfSizing = {
		auto: `${fixedPreviewHeight} w-full max-w-[860px]`,
		width: `${fixedPreviewHeight} w-full min-w-[780px] max-w-none`,
		height: `${fixedPreviewHeight} w-[min(100%,760px)]`,
		manual: `${fixedPreviewHeight} w-[860px] max-w-none`
	};
	if (isImage) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("img", {
		src: sourceUrl,
		alt: invoice.fileName,
		className: `mx-auto ${baseFrame} ${imageSizing[fitMode]}`,
		style
	});
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("iframe", {
		src: framedSourceUrl,
		title: `Original invoice source: ${invoice.fileName}`,
		className: `mx-auto ${baseFrame} ${pdfSizing[fitMode]}`,
		style
	}, `${invoice.id}-${page}`);
}
function IntoWorkbench() {
	const fileInputRef = (0, import_react.useRef)(null);
	const [state, setState] = (0, import_react.useState)({
		users: [],
		currentUser: null,
		permissions: [],
		invoices: [],
		exactConnection: null,
		exactMasterData: null,
		exactMasterDataStale: true,
		exactMasterDataReadOnly: true,
		outlookConnection: null,
		outlookLogs: []
	});
	const [selectedInvoiceId, setSelectedInvoiceId] = (0, import_react.useState)("");
	const [draft, setDraft] = (0, import_react.useState)(null);
	const [message, setMessage] = (0, import_react.useState)("");
	const [busy, setBusy] = (0, import_react.useState)("");
	const [buttonFeedback, setButtonFeedback] = (0, import_react.useState)({});
	const [isDragging, setIsDragging] = (0, import_react.useState)(false);
	const [uploadItems, setUploadItems] = (0, import_react.useState)([]);
	const [duplicatePrompts, setDuplicatePrompts] = (0, import_react.useState)([]);
	const [previewZoom, setPreviewZoom] = (0, import_react.useState)(1);
	const [previewRotation, setPreviewRotation] = (0, import_react.useState)(0);
	const [previewPage, setPreviewPage] = (0, import_react.useState)(1);
	const [previewFitMode, setPreviewFitMode] = (0, import_react.useState)("auto");
	const [previewFullscreen, setPreviewFullscreen] = (0, import_react.useState)(false);
	const [activeView, setActiveView] = (0, import_react.useState)("queue");
	const [archiveFilters, setArchiveFilters] = (0, import_react.useState)(defaultArchiveFilters);
	const [archive, setArchive] = (0, import_react.useState)(null);
	const [auditEvents, setAuditEvents] = (0, import_react.useState)([]);
	const selectedInvoice = (0, import_react.useMemo)(() => state.invoices.find((invoice) => invoice.id === selectedInvoiceId) ?? state.invoices[0] ?? null, [selectedInvoiceId, state.invoices]);
	const selectedPurchaseJournal = selectedInvoice?.purchaseJournal ?? null;
	const firstBookingLine = selectedPurchaseJournal?.lines[0] ?? null;
	const pageCount = selectedInvoice?.fileName.toLowerCase().endsWith(".pdf") ? 3 : 1;
	const hasUnsavedChanges = Boolean(selectedInvoice && draft && JSON.stringify(draft) !== JSON.stringify(selectedInvoice.extractedData));
	const hasPermission = (permission) => state.permissions.includes(permission);
	const stats = (0, import_react.useMemo)(() => {
		const ready = state.invoices.filter((invoice) => invoice.status === "Ready to Book").length;
		const needsCheck = state.invoices.filter((invoice) => reviewStatuses.has(invoice.status)).length;
		const booked = state.invoices.filter((invoice) => invoice.status === "Booked").length;
		return {
			total: state.invoices.length,
			ready,
			needsCheck,
			booked
		};
	}, [state.invoices]);
	const canApproveSelectedIntelligence = Boolean(selectedPurchaseJournal && selectedPurchaseJournal.reviewRequired && !selectedPurchaseJournal.supplierResolution.reviewRequired && selectedPurchaseJournal.attachmentPresent && selectedPurchaseJournal.yourRef && selectedPurchaseJournal.yourRefUnique);
	function setUploadItem(id, patch) {
		setUploadItems((current) => current.map((item) => item.id === id ? {
			...item,
			...patch
		} : item));
	}
	function flashButton(key, feedback) {
		setButtonFeedback((current) => ({
			...current,
			[key]: feedback
		}));
		window.setTimeout(() => {
			setButtonFeedback((current) => {
				const next = { ...current };
				delete next[key];
				return next;
			});
		}, 1800);
	}
	function buttonFeedbackFor(key, loadingKey) {
		return busy === (loadingKey ?? key) ? void 0 : buttonFeedback[key];
	}
	function selectInvoice(invoiceId) {
		if (invoiceId === selectedInvoiceId) return;
		if (hasUnsavedChanges && !window.confirm("You have unsaved edits. Switch invoice and discard them?")) return;
		setSelectedInvoiceId(invoiceId);
	}
	function setPreviewFit(fitMode) {
		setPreviewFitMode(fitMode);
		if (fitMode !== "manual") setPreviewZoom(1);
	}
	function resetPreviewView() {
		setPreviewPage(1);
		setPreviewZoom(1);
		setPreviewRotation(0);
		setPreviewFitMode("auto");
	}
	async function refreshAll() {
		const [invoiceResponse, exactResponse, outlookResponse, userResponse] = await Promise.all([
			fetch("/api/invoices"),
			fetch("/api/exact/status"),
			fetch("/api/outlook/status"),
			fetch("/api/users")
		]);
		const invoiceData = await invoiceResponse.json();
		const exactData = await exactResponse.json();
		const outlookData = await outlookResponse.json();
		const userData = await userResponse.json();
		setState({
			users: userData.users,
			currentUser: userData.currentUser,
			permissions: userData.permissions,
			invoices: invoiceData.invoices,
			exactConnection: exactData.connection,
			exactMasterData: exactData.masterData,
			exactMasterDataStale: exactData.masterDataStale,
			exactMasterDataReadOnly: exactData.masterDataReadOnly,
			outlookConnection: outlookData.connection,
			outlookLogs: outlookData.logs
		});
		if (!selectedInvoiceId && invoiceData.invoices[0]) setSelectedInvoiceId(invoiceData.invoices[0].id);
	}
	async function loadArchive(nextFilters = archiveFilters) {
		setBusy("archive-search");
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(nextFilters)) {
			if (value === "" || value === void 0 || value === null) continue;
			params.set(key, String(value));
		}
		try {
			const response = await fetch(`/api/invoices/archive?${params.toString()}`);
			const data = await response.json();
			if (!response.ok || !data.archive) throw new Error(data.error ?? "Archive search failed.");
			setArchive(data.archive);
			return data.archive;
		} finally {
			setBusy("");
		}
	}
	async function loadAudit(invoiceId) {
		const response = await fetch(`/api/invoices/${invoiceId}/audit`);
		const data = await response.json();
		setAuditEvents(response.ok ? data.events ?? [] : []);
	}
	async function switchUser(userId) {
		setBusy("switch-user");
		try {
			const response = await fetch("/api/users", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ userId })
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error ?? "Could not switch user.");
			setState((current) => ({
				...current,
				users: data.users,
				currentUser: data.currentUser,
				permissions: data.permissions
			}));
			await refreshAll();
			setArchive(null);
			setMessage(`Signed in as ${data.currentUser.name}.`);
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Could not switch user.");
		} finally {
			setBusy("");
		}
	}
	(0, import_react.useEffect)(() => {
		const timeoutId = window.setTimeout(() => {
			refreshAll().catch(() => setMessage("Unable to load the INTO workspace."));
		}, 0);
		return () => window.clearTimeout(timeoutId);
	}, []);
	(0, import_react.useEffect)(() => {
		const params = new URLSearchParams(window.location.search);
		const exactStatus = params.get("exact");
		if (!exactStatus) return;
		const timeoutId = window.setTimeout(() => {
			setMessage(exactStatus === "connected" ? "Exact Online is connected. INTO synced Exact master data." : "Exact Online connection failed. Check your Exact app credentials and redirect URI.");
		}, 0);
		params.delete("exact");
		const nextQuery = params.toString();
		window.history.replaceState(null, "", `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`);
		return () => window.clearTimeout(timeoutId);
	}, []);
	(0, import_react.useEffect)(() => {
		if (!state.exactConnection) return;
		const intervalId = window.setInterval(() => {
			const staleByTime = !state.exactMasterData || new Date(state.exactMasterData.staleAfter).getTime() <= Date.now();
			if ((state.exactMasterDataStale || staleByTime) && !busy) syncExactData({ silent: true }).catch(() => void 0);
		}, 6e4);
		return () => window.clearInterval(intervalId);
	}, [
		busy,
		state.exactConnection,
		state.exactMasterData,
		state.exactMasterDataStale
	]);
	(0, import_react.useEffect)(() => {
		if (selectedInvoice) {
			const nextDraft = { ...selectedInvoice.extractedData };
			const timeoutId = window.setTimeout(() => {
				setDraft(nextDraft);
				setPreviewPage(1);
				setPreviewZoom(1);
				setPreviewRotation(0);
				setPreviewFitMode("auto");
			}, 0);
			return () => window.clearTimeout(timeoutId);
		}
	}, [selectedInvoice]);
	(0, import_react.useEffect)(() => {
		if (!selectedInvoice?.id) {
			const timeoutId = window.setTimeout(() => setAuditEvents([]), 0);
			return () => window.clearTimeout(timeoutId);
		}
		const timeoutId = window.setTimeout(() => {
			loadAudit(selectedInvoice.id).catch(() => setAuditEvents([]));
		}, 0);
		return () => window.clearTimeout(timeoutId);
	}, [selectedInvoice?.id]);
	async function processFiles(fileList) {
		if (!hasPermission("upload")) {
			setMessage("Your role can view and search invoices, but cannot upload files.");
			return;
		}
		const files = Array.from(fileList);
		if (!files.length) return;
		if (busy === "upload") {
			setMessage("Upload is already running.");
			return;
		}
		setBusy("upload");
		setMessage("Checking invoice files...");
		const initialItems = files.map((file, index) => ({
			id: `${file.name}-${file.size}-${file.lastModified}-${index}`,
			fileName: file.name,
			fileSize: file.size,
			progress: 5,
			status: "checking",
			message: "Checking file"
		}));
		setUploadItems(initialItems);
		const batchFingerprints = /* @__PURE__ */ new Set();
		const accepted = [];
		for (const [index, file] of files.entries()) {
			const itemId = initialItems[index].id;
			if (!isAcceptedFile(file)) {
				setUploadItem(itemId, {
					progress: 100,
					status: "error",
					message: `Unsupported file type. Accepted: ${acceptedLabel}.`
				});
				continue;
			}
			try {
				const checksum = await checksumFile(file);
				const fingerprint = [
					file.name.toLowerCase(),
					file.size,
					checksum
				].join("|");
				if (batchFingerprints.has(fingerprint)) {
					setUploadItem(itemId, {
						checksum,
						progress: 100,
						status: "error",
						message: "Duplicate file in this upload batch."
					});
					continue;
				}
				batchFingerprints.add(fingerprint);
				accepted.push({
					file,
					checksum,
					itemId
				});
				setUploadItem(itemId, {
					checksum,
					progress: 25,
					status: "ready",
					message: "Ready to upload"
				});
			} catch {
				setUploadItem(itemId, {
					progress: 100,
					status: "error",
					message: "Could not calculate checksum."
				});
			}
		}
		if (!accepted.length) {
			setBusy("");
			setMessage("No valid new invoice files to upload.");
			flashButton("upload", "error");
			return;
		}
		const formData = new FormData();
		for (const item of accepted) {
			formData.append("files", item.file);
			formData.append("checksums", item.checksum);
			setUploadItem(item.itemId, {
				progress: 35,
				status: "uploading",
				message: "Uploading"
			});
		}
		try {
			const data = await uploadWithProgress(formData, (progress) => {
				const percent = Math.min(90, 35 + Math.round(progress * 55));
				for (const item of accepted) setUploadItem(item.itemId, {
					progress: percent,
					status: "uploading",
					message: "Uploading"
				});
			});
			for (const item of accepted) setUploadItem(item.itemId, {
				progress: 95,
				status: "reading",
				message: "Reading and validating"
			});
			const rejectedByChecksum = new Map((data.rejected ?? []).map((item) => [item.checksum, item.reason]));
			const duplicatesByChecksum = new Map((data.duplicates ?? []).map((item) => [item.checksum, item]));
			for (const item of accepted) {
				const rejectedReason = rejectedByChecksum.get(item.checksum);
				const duplicatePrompt = duplicatesByChecksum.get(item.checksum);
				const processedInvoice = data.processed?.find((invoice) => Boolean(invoice && invoice.checksum === item.checksum));
				if (duplicatePrompt) {
					setUploadItem(item.itemId, {
						progress: 100,
						status: "duplicate",
						message: duplicatePrompt.reason
					});
					continue;
				}
				if (rejectedReason) {
					setUploadItem(item.itemId, {
						progress: 100,
						status: "error",
						message: rejectedReason
					});
					continue;
				}
				setUploadItem(item.itemId, {
					progress: 100,
					status: processedInvoice?.status === "Validation Failed" ? "error" : "success",
					message: processedInvoice ? `Processed - ${displayStatus(processedInvoice.status)}` : "Processed"
				});
			}
			setState((current) => ({
				...current,
				invoices: data.invoices
			}));
			const duplicateUploads = data.duplicates ?? [];
			if (duplicateUploads.length) setDuplicatePrompts((current) => {
				const existing = new Set(current.map((item) => `${item.duplicateInvoiceId}:${item.checksum ?? ""}`));
				return [...current, ...duplicateUploads.filter((item) => !existing.has(`${item.duplicateInvoiceId}:${item.checksum ?? ""}`))];
			});
			const firstProcessed = data.processed?.find((invoice) => Boolean(invoice)) ?? data.invoices[0];
			if (firstProcessed) setSelectedInvoiceId(firstProcessed.id);
			const rejectedCount = data.rejected?.length ?? 0;
			const duplicateCount = data.duplicates?.length ?? 0;
			setMessage(rejectedCount || duplicateCount ? `Processed ${accepted.length - rejectedCount - duplicateCount} invoice file(s), found ${duplicateCount} duplicate(s), rejected ${rejectedCount}.` : `Processed ${accepted.length} invoice file(s).`);
			flashButton("upload", "success");
		} catch (error) {
			for (const item of accepted) setUploadItem(item.itemId, {
				progress: 100,
				status: "error",
				message: error instanceof Error ? error.message : "Upload failed."
			});
			setMessage(error instanceof Error ? error.message : "Upload failed.");
			flashButton("upload", "error");
		} finally {
			setBusy("");
			if (fileInputRef.current) fileInputRef.current.value = "";
		}
	}
	function handleFileInput(event) {
		if (event.target.files?.length) processFiles(event.target.files);
	}
	function handleDrop(event) {
		event.preventDefault();
		setIsDragging(false);
		processFiles(event.dataTransfer.files);
	}
	async function connectExact() {
		setBusy("exact");
		try {
			const response = await fetch("/api/exact/connect", { method: "POST" });
			const data = await response.json();
			if (!response.ok) throw new Error(data.error ?? "Exact Online connection failed.");
			if (data.requiresRedirect && data.authorizationUrl) {
				setMessage("Redirecting to Exact Online to authorize INTO.");
				window.location.assign(data.authorizationUrl);
				return;
			}
			setState((current) => ({
				...current,
				invoices: data.invoices ?? current.invoices,
				exactConnection: data.connection,
				exactMasterData: data.masterData,
				exactMasterDataStale: false,
				exactMasterDataReadOnly: true
			}));
			setMessage(data.mode === "real" ? "Exact Online is connected and master data is synced." : "Exact Online mock connection is active and master data is synced.");
			flashButton("exact", "success");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Exact Online connection failed.");
			flashButton("exact", "error");
		} finally {
			setBusy("");
		}
	}
	async function syncExactData(options = {}) {
		if (!options.silent) setBusy("exact-sync");
		try {
			const response = await fetch("/api/exact/sync", { method: "POST" });
			const data = await response.json();
			if (!response.ok) throw new Error(data.error ?? "Exact master-data sync failed.");
			setState((current) => ({
				...current,
				invoices: data.invoices ?? current.invoices,
				exactMasterData: data.masterData,
				exactMasterDataStale: false,
				exactMasterDataReadOnly: true
			}));
			if (!options.silent) {
				setMessage("Exact master data synced from Exact Online.");
				flashButton("exact-sync", "success");
			}
		} catch (error) {
			if (!options.silent) {
				setMessage(error instanceof Error ? error.message : "Exact master-data sync failed.");
				flashButton("exact-sync", "error");
			}
			throw error;
		} finally {
			if (!options.silent) setBusy("");
		}
	}
	async function connectOutlook() {
		setBusy("outlook-connect");
		try {
			const data = await (await fetch("/api/outlook/connect", { method: "POST" })).json();
			setState((current) => ({
				...current,
				outlookConnection: data.connection
			}));
			setMessage("Outlook mock connection is active.");
			flashButton("outlook-connect", "success");
		} catch {
			setMessage("Outlook connection failed.");
			flashButton("outlook-connect", "error");
		} finally {
			setBusy("");
		}
	}
	async function ingestOutlook() {
		setBusy("outlook-ingest");
		try {
			const response = await fetch("/api/outlook/ingest", { method: "POST" });
			const data = await response.json();
			if (!response.ok) throw new Error(data.error ?? "Outlook ingestion failed.");
			setState((current) => ({
				...current,
				invoices: data.invoices,
				outlookLogs: data.logs
			}));
			if (data.duplicates?.length) setDuplicatePrompts((current) => [...current, ...data.duplicates]);
			setSelectedInvoiceId(data.invoices?.[0]?.id ?? selectedInvoiceId);
			setMessage(data.duplicates?.length ? `Detected invoice emails were processed. ${data.duplicates.length} duplicate(s) need a decision.` : "Detected invoice emails were processed and categorized.");
			flashButton("outlook-ingest", "success");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Outlook ingestion failed.");
			flashButton("outlook-ingest", "error");
		} finally {
			setBusy("");
		}
	}
	async function saveDraft() {
		if (!selectedInvoice || !draft) return;
		if (!hasPermission("edit")) {
			setMessage("Your role can view invoices, but cannot edit invoice data.");
			return;
		}
		setBusy("save");
		try {
			const response = await fetch(`/api/invoices/${selectedInvoice.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(draft)
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error ?? "Save failed.");
			setState((current) => ({
				...current,
				invoices: data.invoices
			}));
			setMessage("Review changes saved and validation reran.");
			flashButton("save", "success");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Save failed.");
			flashButton("save", "error");
		} finally {
			setBusy("");
		}
	}
	async function applyIntelligenceAction(action, accountId) {
		if (!selectedInvoice) return;
		const busyKey = action === "approve" ? "approve-intelligence" : `supplier-${accountId}`;
		setBusy(busyKey);
		try {
			const response = await fetch(`/api/invoices/${selectedInvoice.id}/intelligence`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action,
					accountId
				})
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error ?? "Could not save purchase journal decision.");
			setState((current) => ({
				...current,
				invoices: data.invoices
			}));
			setMessage(action === "selectSupplier" ? "Supplier decision saved and future matches will use it." : "Purchase Journal intelligence approved.");
			flashButton(busyKey, "success");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Could not save purchase journal decision.");
			flashButton(busyKey, "error");
		} finally {
			setBusy("");
		}
	}
	async function resolveDuplicatePrompt(prompt, decision) {
		const busyKey = `duplicate-${decision}-${prompt.duplicateInvoiceId}`;
		setBusy(busyKey);
		try {
			const response = await fetch(`/api/invoices/${prompt.duplicateInvoiceId}/duplicate-resolution`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					decision,
					detectionOutcome: prompt.detection.outcome,
					message: prompt.reason
				})
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error ?? "Duplicate decision failed.");
			setState((current) => ({
				...current,
				invoices: data.invoices ?? current.invoices
			}));
			setDuplicatePrompts((current) => current.filter((item) => !(item.duplicateInvoiceId === prompt.duplicateInvoiceId && item.checksum === prompt.checksum)));
			setSelectedInvoiceId(prompt.duplicateInvoiceId);
			setMessage(decision === "re_read" ? "INTO re-read the existing processed invoice and kept the previous extraction in history." : decision === "keep_existing" ? "Existing processed invoice kept and highlighted." : "Duplicate upload cancelled.");
			flashButton(busyKey, "success");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Duplicate decision failed.");
			flashButton(busyKey, "error");
		} finally {
			setBusy("");
		}
	}
	async function resolveSelectedDuplicate(decision) {
		if (!selectedInvoice?.duplicateDetection) return;
		const busyKey = `selected-duplicate-${decision}`;
		setBusy(busyKey);
		try {
			const response = await fetch(`/api/invoices/${selectedInvoice.id}/duplicate-resolution`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					decision,
					detectionOutcome: selectedInvoice.duplicateDetection.outcome,
					message: selectedInvoice.duplicateDetection.message
				})
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error ?? "Duplicate decision failed.");
			setState((current) => ({
				...current,
				invoices: data.invoices ?? current.invoices
			}));
			setSelectedInvoiceId(data.invoice?.id ?? data.invoices?.[0]?.id ?? "");
			setMessage(decision === "continue_anyway" ? "Duplicate warning cleared and invoice kept for processing." : decision === "re_read" ? "INTO re-read the invoice and saved the previous extraction in history." : "Duplicate invoice upload cancelled.");
			flashButton(busyKey, "success");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Duplicate decision failed.");
			flashButton(busyKey, "error");
		} finally {
			setBusy("");
		}
	}
	async function bookInvoice(invoiceId) {
		const key = `book-${invoiceId}`;
		setBusy(key);
		try {
			const response = await fetch(`/api/invoices/${invoiceId}/book`, { method: "POST" });
			const data = await response.json();
			setState((current) => ({
				...current,
				invoices: current.invoices.map((invoice) => invoice.id === data.invoice?.id ? data.invoice : invoice)
			}));
			if (!response.ok) throw new Error(data.error ?? "Booking failed.");
			setMessage("Invoice booked into mock Exact Online.");
			flashButton(key, "success");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Booking failed.");
			flashButton(key, "error");
		} finally {
			setBusy("");
		}
	}
	async function bookAllReady() {
		setBusy("book-all");
		try {
			const response = await fetch("/api/invoices/book-ready", { method: "POST" });
			const data = await response.json();
			if (!response.ok) throw new Error(data.error ?? "Bulk booking failed.");
			setState((current) => ({
				...current,
				invoices: data.invoices
			}));
			setMessage("Ready invoices were sent to mock Exact Online.");
			flashButton("book-all", "success");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Bulk booking failed.");
			flashButton("book-all", "error");
		} finally {
			setBusy("");
		}
	}
	function updateDraft(field, value) {
		setDraft((current) => {
			if (!current) return current;
			if (field === "netAmount" || field === "vatAmount" || field === "grossAmount") return {
				...current,
				[field]: value === "" ? null : Number(value)
			};
			return {
				...current,
				[field]: value
			};
		});
	}
	function downloadOriginal() {
		if (!selectedInvoice) return;
		const link = document.createElement("a");
		link.href = `/api/invoices/${selectedInvoice.id}/file?download=1`;
		link.download = selectedInvoice.fileName;
		document.body.appendChild(link);
		link.click();
		link.remove();
	}
	function bookDisabledReason(invoice) {
		if (!hasPermission("book")) return "Your role does not allow booking invoices.";
		if (!state.exactConnection) return "Connect Exact Online before booking.";
		if (!state.exactMasterData || state.exactMasterDataStale) return "Sync Exact data before booking so INTO can validate Exact master records.";
		if (invoice.status !== "Ready to Book") return "Book Invoice is disabled because this invoice still needs validation or review.";
		return "";
	}
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("main", {
		className: "min-h-screen bg-[#f6f7f4] text-[#171b1d]",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "mx-auto flex max-w-[1560px] flex-col gap-5 px-5 py-5 lg:px-8",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
					className: "flex flex-col gap-4 border-b border-stone-300 pb-5 lg:flex-row lg:items-end lg:justify-between",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "text-sm font-semibold text-emerald-800",
							children: "INTO"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
							className: "mt-1 text-3xl font-semibold",
							children: "Invoice booking automation"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "mt-2 max-w-3xl text-sm leading-6 text-stone-600",
							children: "Bulk upload invoices, review extracted fields, validate every total, and book approved purchases into Exact Online."
						})
					] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "flex flex-col gap-3",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: "grid grid-cols-4 gap-2 text-center",
							children: [
								["Total", stats.total],
								["Ready", stats.ready],
								["Need check", stats.needsCheck],
								["Booked", stats.booked]
							].map(([label, value]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "min-w-20 rounded-lg border border-stone-300 bg-white px-3 py-2",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "text-lg font-semibold",
									children: value
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "text-xs text-stone-500",
									children: label
								})]
							}, label))
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
							className: "flex flex-col gap-1 text-xs font-semibold text-stone-600",
							children: ["Signed in as", /* @__PURE__ */ (0, import_jsx_runtime.jsx)("select", {
								className: "rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-stone-900",
								value: state.currentUser?.id ?? "",
								onChange: (event) => switchUser(event.target.value),
								disabled: busy === "switch-user",
								children: state.users.map((user) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", {
									value: user.id,
									children: [
										user.name,
										" - ",
										user.role
									]
								}, user.id))
							})]
						})]
					})]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
					className: "grid gap-4 xl:grid-cols-[1.45fr_0.55fr]",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "rounded-lg border border-stone-300 bg-white p-4",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							onClick: () => {
								if (hasPermission("upload")) fileInputRef.current?.click();
							},
							onDragEnter: (event) => {
								event.preventDefault();
								setIsDragging(true);
							},
							onDragOver: (event) => {
								event.preventDefault();
								setIsDragging(true);
							},
							onDragLeave: () => setIsDragging(false),
							onDrop: handleDrop,
							className: `flex min-h-36 flex-col justify-center rounded-md border-2 border-dashed p-5 transition ${hasPermission("upload") ? "cursor-pointer" : "cursor-not-allowed"} ${isDragging ? "border-emerald-500 bg-emerald-50" : "border-stone-300 bg-stone-50 hover:border-emerald-400 hover:bg-emerald-50/50"}`,
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "flex flex-col gap-3 md:flex-row md:items-center md:justify-between",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
										className: "text-lg font-semibold",
										children: "Bulk upload"
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
										className: "mt-1 text-sm text-stone-500",
										children: "Drop multiple invoices here or browse from your computer."
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
										className: "mt-2 text-xs font-semibold text-stone-600",
										children: ["Accepted file types: ", acceptedLabel]
									})
								] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
									onClick: () => fileInputRef.current?.click(),
									loading: busy === "upload",
									feedback: buttonFeedbackFor("upload", "upload"),
									disabled: busy === "upload" || !hasPermission("upload"),
									disabledReason: !hasPermission("upload") ? "Your role does not allow invoice uploads." : "Upload is already running.",
									children: "Browse files"
								})]
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
								ref: fileInputRef,
								className: "sr-only",
								name: "files",
								type: "file",
								multiple: true,
								accept: ".pdf,.jpg,.jpeg,.png,.xml,.ubl,application/pdf,image/jpeg,image/png,text/xml,application/xml",
								onChange: handleFileInput
							})]
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(UploadProgressList, { items: uploadItems })]
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "grid gap-4 md:grid-cols-2 xl:grid-cols-1",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "rounded-lg border border-stone-300 bg-white p-4",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
									className: "text-lg font-semibold",
									children: "Exact Online"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
									className: "mt-1 text-sm text-stone-500",
									children: state.exactConnection ? `Connected to division ${state.exactConnection.divisionCode}` : "Not connected"
								}),
								state.exactMasterDataReadOnly ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs font-semibold text-emerald-900",
									children: "Exact master data is read-only in INTO. Suppliers, journals, G/L accounts, VAT codes, cost centers, cost units, and payment conditions are only read and cached."
								}) : null,
								state.exactMasterData ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "mt-3 rounded-md border border-stone-200 bg-stone-50 p-3 text-xs text-stone-600",
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
											className: "font-semibold text-stone-800",
											children: ["Exact data cache ", state.exactMasterDataStale ? "stale" : "fresh"]
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
											className: "mt-1",
											children: ["Last synced ", formatTimestamp(state.exactMasterData.lastSyncedAt)]
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
											className: "mt-1",
											children: [
												state.exactMasterData.suppliers.length,
												" suppliers,",
												" ",
												state.exactMasterData.glAccounts.length,
												" G/L accounts,",
												" ",
												state.exactMasterData.vatCodes.length,
												" VAT codes"
											]
										})
									]
								}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900",
									children: "Exact master data has not been synced yet."
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "mt-4 flex flex-wrap gap-2",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
										variant: "outline",
										onClick: connectExact,
										loading: busy === "exact",
										feedback: buttonFeedbackFor("exact", "exact"),
										disabled: busy === "exact" || !hasPermission("connect_exact"),
										disabledReason: !hasPermission("connect_exact") ? "Your role cannot connect Exact Online." : "Exact Online connection is in progress.",
										children: state.exactConnection ? "Reconnect" : "Connect Exact Online"
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
										variant: "secondary",
										onClick: () => syncExactData(),
										loading: busy === "exact-sync",
										feedback: buttonFeedbackFor("exact-sync", "exact-sync"),
										disabled: !state.exactConnection || !hasPermission("connect_exact") || busy === "exact-sync" || busy === "exact",
										disabledReason: !hasPermission("connect_exact") ? "Your role cannot sync Exact Online data." : "Connect Exact Online before syncing Exact data.",
										children: "Sync Exact Data Now"
									})]
								})
							]
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "rounded-lg border border-stone-300 bg-white p-4",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
									className: "text-lg font-semibold",
									children: "Outlook ingestion"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
									className: "mt-1 text-sm text-stone-500",
									children: state.outlookConnection ? `Connected to ${state.outlookConnection.mailboxAddress}` : "Not connected"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "mt-4 flex flex-wrap gap-2",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
										variant: "outline",
										onClick: connectOutlook,
										loading: busy === "outlook-connect",
										feedback: buttonFeedbackFor("outlook-connect", "outlook-connect"),
										disabled: busy === "outlook-connect" || !hasPermission("connect_outlook"),
										disabledReason: !hasPermission("connect_outlook") ? "Your role cannot connect Outlook." : "Outlook connection is in progress.",
										children: state.outlookConnection ? "Reconnect" : "Connect Outlook"
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
										variant: "secondary",
										onClick: ingestOutlook,
										loading: busy === "outlook-ingest",
										feedback: buttonFeedbackFor("outlook-ingest", "outlook-ingest"),
										disabled: !state.outlookConnection || busy === "outlook-ingest" || !hasPermission("upload") || !hasPermission("connect_outlook"),
										disabledReason: !hasPermission("upload") || !hasPermission("connect_outlook") ? "Your role cannot scan Outlook invoices." : "Scan Outlook Now is disabled until Outlook is connected.",
										children: "Scan Outlook Now"
									})]
								})
							]
						})]
					})]
				}),
				message ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "rounded-lg border border-stone-300 bg-[#fffdf5] px-4 py-3 text-sm text-stone-700",
					children: message
				}) : null,
				duplicatePrompts.length ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
					className: "rounded-lg border border-fuchsia-300 bg-fuchsia-50 p-4",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "flex flex-col gap-1",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
							className: "text-lg font-semibold text-fuchsia-950",
							children: "Duplicate invoice decisions"
						})
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "mt-3 grid gap-3",
						children: duplicatePrompts.map((prompt) => {
							const alreadyBooked = prompt.detection.outcome === "already_booked";
							const candidate = prompt.detection.candidates[0];
							return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								className: "rounded-lg border border-fuchsia-200 bg-white p-3 text-sm",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
											className: "font-semibold text-fuchsia-950",
											children: prompt.fileName
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
											className: "mt-1 text-stone-700",
											children: prompt.reason
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dl", {
											className: "mt-2 grid gap-1 text-xs text-stone-600 sm:grid-cols-[140px_1fr]",
											children: [
												/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", { children: "Existing record" }),
												/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", { children: candidate?.fileName ?? prompt.duplicateInvoiceId }),
												/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", { children: "Status" }),
												/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", { children: candidate?.status ?? "-" }),
												/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", { children: "Exact reference" }),
												/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", { children: prompt.exactBookingId ?? candidate?.exactBookingId ?? "-" }),
												/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", { children: "Match" }),
												/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dd", { children: [
													candidate ? percentScore(candidate.matchScore) : "-",
													" ",
													candidate?.matchReasons.join(" ")
												] })
											]
										})
									] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										className: "flex flex-wrap gap-2",
										children: alreadyBooked ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
											variant: "secondary",
											onClick: () => {
												setSelectedInvoiceId(prompt.duplicateInvoiceId);
												setDuplicatePrompts((current) => current.filter((item) => item !== prompt));
											},
											children: "Show existing invoice"
										}) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
												variant: "secondary",
												onClick: () => resolveDuplicatePrompt(prompt, "re_read"),
												loading: busy === `duplicate-re_read-${prompt.duplicateInvoiceId}`,
												feedback: buttonFeedbackFor(`duplicate-re_read-${prompt.duplicateInvoiceId}`, `duplicate-re_read-${prompt.duplicateInvoiceId}`),
												children: "Re-read invoice"
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
												variant: "outline",
												onClick: () => resolveDuplicatePrompt(prompt, "keep_existing"),
												loading: busy === `duplicate-keep_existing-${prompt.duplicateInvoiceId}`,
												feedback: buttonFeedbackFor(`duplicate-keep_existing-${prompt.duplicateInvoiceId}`, `duplicate-keep_existing-${prompt.duplicateInvoiceId}`),
												children: "Keep existing processed invoice"
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
												variant: "ghost",
												onClick: () => resolveDuplicatePrompt(prompt, "cancel_upload"),
												loading: busy === `duplicate-cancel_upload-${prompt.duplicateInvoiceId}`,
												feedback: buttonFeedbackFor(`duplicate-cancel_upload-${prompt.duplicateInvoiceId}`, `duplicate-cancel_upload-${prompt.duplicateInvoiceId}`),
												children: "Cancel upload"
											})
										] })
									})]
								})
							}, `${prompt.duplicateInvoiceId}-${prompt.checksum ?? prompt.fileName}`);
						})
					})]
				}) : null,
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "flex flex-wrap gap-2",
					children: ["queue", "archive"].map((view) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
						variant: activeView === view ? "secondary" : "ghost",
						onClick: () => {
							setActiveView(view);
							if (view === "archive" && !archive) loadArchive().catch((error) => setMessage(error instanceof Error ? error.message : "Archive search failed."));
						},
						disabled: view === "archive" && !hasPermission("search_archive"),
						disabledReason: "Your role does not allow archive search.",
						children: view === "queue" ? "Processing queue" : "Invoice archive"
					}, view))
				}),
				activeView === "archive" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
					className: "rounded-lg border border-stone-300 bg-white p-4",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
								className: "text-lg font-semibold",
								children: "Invoice archive"
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "text-sm text-stone-500",
								children: "Search retained invoice records from all INTO users."
							})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "flex flex-wrap gap-2",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
									variant: "secondary",
									onClick: () => loadArchive({
										...archiveFilters,
										page: 1
									}).then(() => setArchiveFilters((current) => ({
										...current,
										page: 1
									}))).catch((error) => setMessage(error instanceof Error ? error.message : "Archive search failed.")),
									loading: busy === "archive-search",
									disabled: !hasPermission("search_archive"),
									disabledReason: "Your role does not allow archive search.",
									children: "Search archive"
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
									variant: "ghost",
									onClick: () => {
										setArchiveFilters(defaultArchiveFilters);
										loadArchive(defaultArchiveFilters).catch((error) => setMessage(error instanceof Error ? error.message : "Archive search failed."));
									},
									children: "Reset filters"
								})]
							})]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4",
							children: [
								[
									["keyword", "Keyword"],
									["supplier", "Supplier"],
									["invoiceNumber", "Invoice / Your ref."],
									["exactBookingReference", "Exact reference"],
									["invoiceDateFrom", "Invoice from"],
									["invoiceDateTo", "Invoice to"],
									["uploadedAtFrom", "Uploaded from"],
									["uploadedAtTo", "Uploaded to"],
									["amountMin", "Min amount"],
									["amountMax", "Max amount"],
									["currency", "Currency"],
									["journal", "Journal"],
									["glAccount", "G/L account"],
									["vatCode", "VAT code"],
									["costCenter", "Cost center"],
									["costUnit", "Cost unit"],
									["country", "Country"]
								].map(([field, label]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
									className: "flex flex-col gap-1 text-sm",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-semibold text-stone-700",
										children: label
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
										className: "rounded-md border border-stone-300 px-3 py-2",
										type: field.toLowerCase().includes("date") || field.toLowerCase().includes("from") || field.toLowerCase().includes("to") ? "date" : field.toLowerCase().includes("amount") ? "number" : "text",
										value: String(archiveFilters[field] ?? ""),
										onChange: (event) => setArchiveFilters((current) => ({
											...current,
											[field]: event.target.value,
											page: 1
										}))
									})]
								}, field)),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
									className: "flex flex-col gap-1 text-sm",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-semibold text-stone-700",
										children: "Status"
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", {
										className: "rounded-md border border-stone-300 px-3 py-2",
										value: archiveFilters.bookingStatus,
										onChange: (event) => setArchiveFilters((current) => ({
											...current,
											bookingStatus: event.target.value,
											page: 1
										})),
										children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
											value: "",
											children: "All"
										}), Object.keys(statusTone).map((status) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
											value: status,
											children: displayStatus(status)
										}, status))]
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
									className: "flex flex-col gap-1 text-sm",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-semibold text-stone-700",
										children: "Validation"
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", {
										className: "rounded-md border border-stone-300 px-3 py-2",
										value: archiveFilters.validationStatus,
										onChange: (event) => setArchiveFilters((current) => ({
											...current,
											validationStatus: event.target.value,
											page: 1
										})),
										children: [
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
												value: "",
												children: "All"
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
												value: "valid",
												children: "Valid"
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
												value: "warning",
												children: "Warning"
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
												value: "error",
												children: "Error"
											})
										]
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
									className: "flex flex-col gap-1 text-sm",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-semibold text-stone-700",
										children: "Source"
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", {
										className: "rounded-md border border-stone-300 px-3 py-2",
										value: archiveFilters.source,
										onChange: (event) => setArchiveFilters((current) => ({
											...current,
											source: event.target.value,
											page: 1
										})),
										children: [
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
												value: "",
												children: "All"
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
												value: "manual",
												children: "Manual upload"
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
												value: "outlook",
												children: "Outlook"
											})
										]
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
									className: "flex flex-col gap-1 text-sm",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-semibold text-stone-700",
										children: "Duplicate status"
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", {
										className: "rounded-md border border-stone-300 px-3 py-2",
										value: archiveFilters.duplicateStatus,
										onChange: (event) => setArchiveFilters((current) => ({
											...current,
											duplicateStatus: event.target.value,
											page: 1
										})),
										children: [
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
												value: "",
												children: "All"
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
												value: "none",
												children: "None"
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
												value: "already_booked",
												children: "Already booked"
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
												value: "processed_unbooked",
												children: "Processed unbooked"
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
												value: "possible_duplicate",
												children: "Possible duplicate"
											})
										]
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
									className: "flex flex-col gap-1 text-sm",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-semibold text-stone-700",
										children: "Uploaded by"
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", {
										className: "rounded-md border border-stone-300 px-3 py-2",
										value: archiveFilters.uploadedByUserId,
										onChange: (event) => setArchiveFilters((current) => ({
											...current,
											uploadedByUserId: event.target.value,
											page: 1
										})),
										children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
											value: "",
											children: "All users"
										}), state.users.map((user) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
											value: user.id,
											children: user.name
										}, user.id))]
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
									className: "flex flex-col gap-1 text-sm",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-semibold text-stone-700",
										children: "Sort by"
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", {
										className: "rounded-md border border-stone-300 px-3 py-2",
										value: archiveFilters.sortBy,
										onChange: (event) => setArchiveFilters((current) => ({
											...current,
											sortBy: event.target.value,
											page: 1
										})),
										children: [
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
												value: "uploadedAt",
												children: "Upload date"
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
												value: "invoiceDate",
												children: "Invoice date"
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
												value: "supplier",
												children: "Supplier"
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
												value: "amount",
												children: "Amount"
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
												value: "status",
												children: "Status"
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
												value: "uploader",
												children: "Uploader"
											})
										]
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
									className: "flex flex-col gap-1 text-sm",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-semibold text-stone-700",
										children: "Sort direction"
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", {
										className: "rounded-md border border-stone-300 px-3 py-2",
										value: archiveFilters.sortDirection,
										onChange: (event) => setArchiveFilters((current) => ({
											...current,
											sortDirection: event.target.value === "asc" ? "asc" : "desc",
											page: 1
										})),
										children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
											value: "desc",
											children: "Descending"
										}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
											value: "asc",
											children: "Ascending"
										})]
									})]
								})
							]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: "mt-4 overflow-x-auto rounded-md border border-stone-200",
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("table", {
								className: "w-full min-w-[1160px] border-collapse text-left text-sm",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("thead", {
									className: "bg-stone-100 text-xs font-semibold text-stone-600",
									children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "px-3 py-2",
											children: "Invoice date"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "px-3 py-2",
											children: "Supplier"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "px-3 py-2",
											children: "Invoice"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "px-3 py-2",
											children: "Total"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "px-3 py-2",
											children: "Status"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "px-3 py-2",
											children: "Source"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "px-3 py-2",
											children: "Uploaded by"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "px-3 py-2",
											children: "Exact ref."
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "px-3 py-2",
											children: "Last updated"
										})
									] })
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tbody", { children: [(archive?.invoices ?? []).map((invoice) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", {
									className: `border-t border-stone-200 ${selectedInvoice?.id === invoice.id ? "bg-emerald-50" : ""}`,
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
											className: "px-3 py-2",
											children: invoice.extractedData.invoiceDate || "-"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
											className: "px-3 py-2",
											children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
												onClick: () => {
													selectInvoice(invoice.id);
													setActiveView("queue");
												},
												className: "cursor-pointer text-left font-semibold text-[#145c48] hover:underline",
												children: invoice.extractedData.supplierName || invoice.fileName
											})
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
											className: "px-3 py-2",
											children: invoice.extractedData.invoiceNumber || invoice.extractedData.referenceCode || "-"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
											className: "px-3 py-2",
											children: money(invoice)
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
											className: "px-3 py-2",
											children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
												className: `inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${statusTone[invoice.status] ?? statusTone.Uploaded}`,
												children: displayStatus(invoice.status)
											})
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
											className: "px-3 py-2",
											children: invoice.source
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
											className: "px-3 py-2",
											children: invoice.uploadedByName
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
											className: "px-3 py-2",
											children: invoice.exactBookingId ?? "-"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
											className: "px-3 py-2",
											children: formatTimestamp(invoice.updatedAt)
										})
									]
								}, invoice.id)), !archive?.invoices.length ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tr", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
									className: "px-3 py-8 text-center text-stone-500",
									colSpan: 9,
									children: "No archived invoices match the current filters."
								}) }) : null] })]
							})
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-stone-600",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: archive ? `${archive.total} result(s), page ${archive.page} of ${archive.totalPages}` : "Run a search to load archive results." }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "flex gap-2",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
									variant: "ghost",
									onClick: () => {
										const next = {
											...archiveFilters,
											page: Math.max(1, archiveFilters.page - 1)
										};
										setArchiveFilters(next);
										loadArchive(next).catch((error) => setMessage(error instanceof Error ? error.message : "Archive search failed."));
									},
									disabled: !archive || archive.page <= 1,
									disabledReason: "Already on the first archive page.",
									className: "min-h-8 px-3 py-1 text-xs",
									children: "Previous"
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
									variant: "ghost",
									onClick: () => {
										const next = {
											...archiveFilters,
											page: Math.min(archive?.totalPages ?? archiveFilters.page, archiveFilters.page + 1)
										};
										setArchiveFilters(next);
										loadArchive(next).catch((error) => setMessage(error instanceof Error ? error.message : "Archive search failed."));
									},
									disabled: !archive || archive.page >= archive.totalPages,
									disabledReason: "Already on the last archive page.",
									className: "min-h-8 px-3 py-1 text-xs",
									children: "Next"
								})]
							})]
						})
					]
				}) : null,
				activeView === "queue" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
					className: "rounded-lg border border-stone-300 bg-white",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "flex flex-col gap-3 border-b border-stone-200 p-4 md:flex-row md:items-center md:justify-between",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
								className: "text-lg font-semibold",
								children: "Invoice queue"
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "text-sm text-stone-500",
								children: "Select an invoice to compare the source document with extracted booking data."
							})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
								variant: "secondary",
								onClick: bookAllReady,
								loading: busy === "book-all",
								feedback: buttonFeedbackFor("book-all", "book-all"),
								disabled: !stats.ready || !hasPermission("book") || !state.exactConnection || !state.exactMasterData || state.exactMasterDataStale || busy === "book-all",
								disabledReason: !hasPermission("book") ? "Your role does not allow booking invoices." : !state.exactConnection ? "Connect Exact Online before booking ready invoices." : !state.exactMasterData || state.exactMasterDataStale ? "Sync Exact data before booking ready invoices." : "Book All Ready Invoices is disabled because no invoices are ready.",
								children: "Book all ready invoices"
							})]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: "grid gap-3 p-4 md:hidden",
							children: state.invoices.map((invoice) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
								onClick: () => selectInvoice(invoice.id),
								className: `cursor-pointer rounded-lg border p-3 text-left ${selectedInvoice?.id === invoice.id ? "border-emerald-400 bg-emerald-50 shadow-sm" : "border-stone-200 bg-white"}`,
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "flex items-start justify-between gap-3",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										className: "font-semibold text-[#145c48]",
										children: invoice.fileName
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
										className: "mt-1 text-xs text-stone-500",
										children: [
											invoice.source,
											" - ",
											formatFileSize(invoice.fileSize)
										]
									})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: `rounded-md border px-2 py-1 text-xs font-semibold ${statusTone[invoice.status] ?? statusTone.Uploaded}`,
										children: displayStatus(invoice.status)
									})]
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "mt-3 grid grid-cols-2 gap-2 text-sm",
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
											className: "text-stone-500",
											children: "Supplier"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: invoice.extractedData.supplierName || "-" }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
											className: "text-stone-500",
											children: "Invoice"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: invoice.extractedData.invoiceNumber || "-" }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
											className: "text-stone-500",
											children: "Amount"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: money(invoice) }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
											className: "text-stone-500",
											children: "Journal"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: invoice.purchaseJournal?.journal ?? "-" }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
											className: "text-stone-500",
											children: "Confidence"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: invoice.purchaseJournal ? percentScore(invoice.purchaseJournal.confidenceScores.overall) : "-" }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
											className: "text-stone-500",
											children: "Issues"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: invoice.validationErrors.length })
									]
								})]
							}, invoice.id))
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: "hidden overflow-x-auto md:block",
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("table", {
								className: "w-full min-w-[1040px] border-collapse text-left text-sm",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("thead", {
									className: "bg-stone-100 text-xs font-semibold text-stone-600",
									children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "px-4 py-3",
											children: "File"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "px-4 py-3",
											children: "Supplier"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "px-4 py-3",
											children: "Invoice"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "px-4 py-3",
											children: "Amount"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "px-4 py-3",
											children: "Journal"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "px-4 py-3",
											children: "Confidence"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "px-4 py-3",
											children: "Status"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "px-4 py-3",
											children: "Issues"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
											className: "px-4 py-3",
											children: "Action"
										})
									] })
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tbody", { children: state.invoices.map((invoice) => {
									const disabledReason = bookDisabledReason(invoice);
									return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", {
										className: `border-t border-stone-200 ${selectedInvoice?.id === invoice.id ? "bg-emerald-50/70 ring-1 ring-inset ring-emerald-200" : ""}`,
										children: [
											/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("td", {
												className: "px-4 py-3",
												children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
													onClick: () => selectInvoice(invoice.id),
													className: "cursor-pointer text-left font-semibold text-[#145c48] hover:underline",
													children: invoice.fileName
												}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
													className: "mt-1 text-xs text-stone-500",
													children: [
														invoice.source,
														" - ",
														formatFileSize(invoice.fileSize)
													]
												})]
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
												className: "px-4 py-3",
												children: invoice.extractedData.supplierName || "-"
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
												className: "px-4 py-3",
												children: invoice.extractedData.invoiceNumber || "-"
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
												className: "px-4 py-3",
												children: money(invoice)
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
												className: "px-4 py-3",
												children: invoice.purchaseJournal?.journal ?? "-"
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
												className: "px-4 py-3",
												children: invoice.purchaseJournal ? percentScore(invoice.purchaseJournal.confidenceScores.overall) : "-"
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
												className: "px-4 py-3",
												children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
													className: `inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${statusTone[invoice.status] ?? statusTone.Uploaded}`,
													children: displayStatus(invoice.status)
												})
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
												className: "px-4 py-3",
												children: invoice.validationErrors.length ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
													className: "font-semibold text-amber-800",
													children: invoice.validationErrors.length
												}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
													className: "text-stone-400",
													children: "0"
												})
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
												className: "px-4 py-3",
												children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
													variant: "outline",
													onClick: () => bookInvoice(invoice.id),
													loading: busy === `book-${invoice.id}`,
													feedback: buttonFeedbackFor(`book-${invoice.id}`, `book-${invoice.id}`),
													disabled: invoice.status !== "Ready to Book" || !hasPermission("book") || !state.exactConnection || !state.exactMasterData || state.exactMasterDataStale || busy === `book-${invoice.id}`,
													disabledReason,
													className: "min-h-9 px-3 py-1 text-xs",
													children: "Book invoice"
												})
											})
										]
									}, invoice.id);
								}) })]
							})
						})
					]
				}) : null,
				selectedInvoice && draft ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
					className: "grid gap-4 xl:grid-cols-[0.95fr_1.05fr]",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
						className: previewFullscreen ? "fixed inset-4 z-50 flex flex-col overflow-hidden rounded-lg border border-stone-300 bg-white shadow-2xl" : "rounded-lg border border-stone-300 bg-white",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "flex flex-col gap-3 border-b border-stone-200 p-4 lg:flex-row lg:items-center lg:justify-between",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
									className: "text-lg font-semibold",
									children: "Invoice preview"
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
									className: "text-sm text-stone-500",
									children: [
										selectedInvoice.fileName,
										" - ",
										formatFileSize(selectedInvoice.fileSize)
									]
								})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "flex flex-wrap gap-2",
									children: [
										[
											"auto",
											"width",
											"height"
										].map((fitMode) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
											variant: previewFitMode === fitMode ? "secondary" : "ghost",
											onClick: () => setPreviewFit(fitMode),
											className: "min-h-9 px-3 py-1 text-xs",
											children: previewFitModeLabels[fitMode]
										}, fitMode)),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
											variant: "ghost",
											onClick: () => {
												setPreviewFitMode("manual");
												setPreviewZoom((value) => Math.max(.65, value - .1));
											},
											disabled: previewZoom <= .65,
											disabledReason: "Minimum zoom reached.",
											className: "min-h-9 px-3 py-1 text-xs",
											children: "Zoom out"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
											variant: "ghost",
											onClick: () => {
												setPreviewFitMode("manual");
												setPreviewZoom((value) => Math.min(1.8, value + .1));
											},
											disabled: previewZoom >= 1.8,
											disabledReason: "Maximum zoom reached.",
											className: "min-h-9 px-3 py-1 text-xs",
											children: "Zoom in"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
											variant: "ghost",
											onClick: () => setPreviewRotation((value) => (value + 270) % 360),
											className: "min-h-9 px-3 py-1 text-xs",
											children: "Rotate left"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
											variant: "ghost",
											onClick: () => setPreviewRotation((value) => (value + 90) % 360),
											className: "min-h-9 px-3 py-1 text-xs",
											children: "Rotate right"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
											variant: "ghost",
											onClick: resetPreviewView,
											className: "min-h-9 px-3 py-1 text-xs",
											children: "Reset view"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
											variant: previewFullscreen ? "secondary" : "outline",
											onClick: () => setPreviewFullscreen((value) => !value),
											className: "min-h-9 px-3 py-1 text-xs",
											children: previewFullscreen ? "Exit fullscreen" : "Fullscreen preview"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
											variant: "outline",
											onClick: downloadOriginal,
											className: "min-h-9 px-3 py-1 text-xs",
											children: "Download original"
										})
									]
								})]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 px-4 py-2 text-sm",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "text-stone-600",
									children: [
										"Page ",
										previewPage,
										" of ",
										pageCount,
										" - ",
										previewFitModeLabels[previewFitMode],
										" - Zoom ",
										Math.round(previewZoom * 100),
										"%",
										previewRotation ? ` - Rotated ${previewRotation}deg` : ""
									]
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "flex gap-2",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
										variant: "ghost",
										onClick: () => setPreviewPage((value) => Math.max(1, value - 1)),
										disabled: previewPage <= 1,
										disabledReason: "Already on the first page.",
										className: "min-h-8 px-3 py-1 text-xs",
										children: "Previous"
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
										variant: "ghost",
										onClick: () => setPreviewPage((value) => Math.min(pageCount, value + 1)),
										disabled: previewPage >= pageCount,
										disabledReason: "Already on the last page.",
										className: "min-h-8 px-3 py-1 text-xs",
										children: "Next"
									})]
								})]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								className: `overflow-auto bg-stone-100 p-4 ${previewFullscreen ? "flex-1" : "max-h-[900px]"}`,
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(PreviewDocument, {
									invoice: selectedInvoice,
									zoom: previewZoom,
									rotation: previewRotation,
									page: previewPage,
									fitMode: previewFitMode,
									fullscreen: previewFullscreen
								})
							})
						]
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("aside", {
						className: "rounded-lg border border-stone-300 bg-white",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "border-b border-stone-200 p-4",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
								className: "text-lg font-semibold",
								children: "Review invoice"
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "text-sm text-stone-500",
								children: "Fix fields here, then save to rerun validation."
							})]
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "flex flex-col gap-4 p-4",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "flex flex-wrap items-center gap-2",
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
											className: `rounded-md border px-2 py-1 text-xs font-semibold ${statusTone[selectedInvoice.status] ?? statusTone.Uploaded}`,
											children: displayStatus(selectedInvoice.status)
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
											className: "text-xs text-stone-500",
											children: [
												"Extraction confidence",
												" ",
												Math.round((selectedInvoice.extractedData.confidence ?? 0) * 100),
												"%"
											]
										}),
										hasUnsavedChanges ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
											className: "rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900",
											children: "Unsaved edits"
										}) : null,
										selectedInvoice.extractionHistory.length ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
											className: "rounded-md border border-stone-300 bg-stone-50 px-2 py-1 text-xs font-semibold text-stone-700",
											children: ["Extraction history ", selectedInvoice.extractionHistory.length]
										}) : null
									]
								}),
								selectedInvoice.validationErrors.length ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "rounded-lg border border-amber-300 bg-amber-50 p-3",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", {
										className: "text-sm font-semibold text-amber-950",
										children: "Validation warnings"
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", {
										className: "mt-2 space-y-1 text-sm text-amber-900",
										children: selectedInvoice.validationErrors.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: item.message }, item.id))
									})]
								}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm font-semibold text-emerald-900",
									children: "All required fields are valid."
								}),
								selectedInvoice.duplicateDetection?.outcome === "possible_duplicate" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "rounded-lg border border-fuchsia-300 bg-fuchsia-50 p-3",
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", {
											className: "text-sm font-semibold text-fuchsia-950",
											children: "Possible duplicate"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
											className: "mt-1 text-sm text-fuchsia-900",
											children: selectedInvoice.duplicateDetection.message
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
											className: "mt-3 grid gap-2",
											children: selectedInvoice.duplicateDetection.candidates.map((candidate) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
												onClick: () => selectInvoice(candidate.invoiceId),
												className: "cursor-pointer rounded-md border border-fuchsia-200 bg-white p-2 text-left text-sm hover:bg-fuchsia-50",
												children: [
													/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
														className: "font-semibold",
														children: [
															candidate.fileName,
															" - ",
															percentScore(candidate.matchScore)
														]
													}),
													/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
														className: "mt-1 text-xs text-stone-600",
														children: [
															candidate.supplierName || "-",
															" /",
															" ",
															candidate.invoiceNumber || candidate.yourRef || "-",
															" /",
															" ",
															formatMoney(candidate.totalAmount)
														]
													}),
													/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
														className: "mt-1 text-xs text-stone-500",
														children: candidate.matchReasons.join(" ")
													})
												]
											}, candidate.invoiceId))
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
											className: "mt-3 flex flex-wrap gap-2",
											children: [
												/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
													variant: "secondary",
													onClick: () => resolveSelectedDuplicate("continue_anyway"),
													loading: busy === "selected-duplicate-continue_anyway",
													feedback: buttonFeedbackFor("selected-duplicate-continue_anyway", "selected-duplicate-continue_anyway"),
													children: "Continue anyway"
												}),
												/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
													variant: "outline",
													onClick: () => resolveSelectedDuplicate("re_read"),
													loading: busy === "selected-duplicate-re_read",
													feedback: buttonFeedbackFor("selected-duplicate-re_read", "selected-duplicate-re_read"),
													children: "Re-read invoice"
												}),
												/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
													variant: "ghost",
													onClick: () => resolveSelectedDuplicate("cancel_upload"),
													loading: busy === "selected-duplicate-cancel_upload",
													feedback: buttonFeedbackFor("selected-duplicate-cancel_upload", "selected-duplicate-cancel_upload"),
													children: "Cancel upload"
												})
											]
										})
									]
								}) : null,
								selectedPurchaseJournal ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
									className: "space-y-4 border-y border-stone-200 py-4",
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
											className: "flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between",
											children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", {
												className: "text-sm font-semibold",
												children: "Purchase Journal intelligence"
											}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
												className: "mt-1 text-xs text-stone-500",
												children: ["Threshold ", percentScore(selectedPurchaseJournal.confidenceThreshold)]
											})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
												variant: "ghost",
												onClick: () => applyIntelligenceAction("approve"),
												loading: busy === "approve-intelligence",
												feedback: buttonFeedbackFor("approve-intelligence", "approve-intelligence"),
												disabled: !hasPermission("approve") || !canApproveSelectedIntelligence || busy === "approve-intelligence",
												disabledReason: !hasPermission("approve") ? "Your role does not allow approving purchase journal intelligence." : "Approval is available only after required supplier, attachment, and reference checks are resolved.",
												children: "Approve intelligence"
											})]
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
											className: "grid gap-2 sm:grid-cols-2 xl:grid-cols-3",
											children: Object.entries(selectedPurchaseJournal.confidenceScores).map(([key, value]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
												className: `rounded-md border px-3 py-2 text-sm ${confidenceTone(value, selectedPurchaseJournal.confidenceThreshold)}`,
												children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
													className: "text-xs font-semibold",
													children: confidenceLabels[key] ?? key
												}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
													className: "mt-1 text-lg font-semibold",
													children: percentScore(value)
												})]
											}, key))
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
											className: "grid gap-3 text-sm md:grid-cols-2",
											children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
												className: "rounded-md border border-stone-200 p-3",
												children: [
													/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
														className: "text-xs font-semibold text-stone-500",
														children: "Attachment"
													}),
													/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
														className: "mt-1 font-semibold",
														children: selectedPurchaseJournal.attachmentPresent ? "Ready to upload with booking" : "Missing"
													}),
													/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
														className: "mt-1 break-all text-xs text-stone-500",
														children: selectedPurchaseJournal.attachmentStorageKey ?? "-"
													})
												]
											}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
												className: "rounded-md border border-stone-200 p-3",
												children: [
													/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
														className: "text-xs font-semibold text-stone-500",
														children: "Supplier"
													}),
													/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
														className: "mt-1 font-semibold",
														children: selectedPurchaseJournal.supplierResolution.selectedAccountName ?? "Review required"
													}),
													/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
														className: "mt-1 text-xs text-stone-500",
														children: [
															selectedPurchaseJournal.supplierResolution.method,
															" -",
															" ",
															percentScore(selectedPurchaseJournal.supplierResolution.matchConfidence)
														]
													})
												]
											})]
										}),
										selectedPurchaseJournal.supplierResolution.reviewRequired ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
											className: "rounded-md border border-orange-300 bg-orange-50 p-3",
											children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
												className: "text-sm font-semibold text-orange-950",
												children: "Supplier Review Required"
											}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
												className: "mt-2 grid gap-2",
												children: selectedPurchaseJournal.supplierResolution.candidates.map((candidate) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
													variant: "ghost",
													onClick: () => applyIntelligenceAction("selectSupplier", candidate.account.id),
													loading: busy === `supplier-${candidate.account.id}`,
													feedback: buttonFeedbackFor(`supplier-${candidate.account.id}`, `supplier-${candidate.account.id}`),
													disabled: !hasPermission("approve"),
													disabledReason: "Your role does not allow supplier resolution decisions.",
													className: "justify-start text-left",
													children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
														candidate.account.code,
														" - ",
														candidate.account.name,
														/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
															className: "block text-xs font-normal text-stone-500",
															children: [
																candidate.method,
																" -",
																" ",
																percentScore(candidate.confidence)
															]
														})
													] })
												}, candidate.account.id))
											})]
										}) : null,
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
											className: "grid gap-3 text-sm md:grid-cols-2",
											children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
												className: "rounded-md border border-stone-200 p-3",
												children: [
													/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
														className: "text-xs font-semibold text-stone-500",
														children: "Entry data"
													}),
													/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dl", {
														className: "mt-2 grid grid-cols-[120px_1fr] gap-1",
														children: [
															/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
																className: "text-stone-500",
																children: "Journal"
															}),
															/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dd", { children: [
																selectedPurchaseJournal.journal,
																" -",
																" ",
																selectedPurchaseJournal.journalReason
															] }),
															/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
																className: "text-stone-500",
																children: "Year / period"
															}),
															/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dd", { children: [
																selectedPurchaseJournal.financialYear,
																" /",
																" ",
																selectedPurchaseJournal.period
															] }),
															/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
																className: "text-stone-500",
																children: "Entry no."
															}),
															/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", { children: selectedPurchaseJournal.entryNumber })
														]
													}),
													selectedPurchaseJournal.periodAdjusted ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
														className: "mt-2 text-xs text-amber-700",
														children: selectedPurchaseJournal.periodAdjustmentLog
													}) : null
												]
											}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
												className: "rounded-md border border-stone-200 p-3",
												children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
													className: "text-xs font-semibold text-stone-500",
													children: "Suggested corrections"
												}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", {
													className: "mt-2 space-y-1 text-sm",
													children: (selectedPurchaseJournal.reviewReasons.length ? selectedPurchaseJournal.reviewReasons : selectedPurchaseJournal.reasoningLog.slice(0, 3)).map((reason) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: reason }, reason))
												})]
											})]
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
											className: "grid gap-3 sm:grid-cols-2 lg:grid-cols-3",
											children: [
												["VAT code", firstBookingLine?.vatCode ?? ""],
												["G/L account", firstBookingLine ? `${firstBookingLine.glAccount} ${firstBookingLine.glAccountName}` : ""],
												["Cost center", firstBookingLine?.costCentre ?? ""],
												["Cost unit", firstBookingLine?.costUnit ?? ""],
												["Accrual From", firstBookingLine?.from ?? ""],
												["Accrual To", firstBookingLine?.to ?? ""]
											].map(([label, value]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
												className: "flex flex-col gap-1 text-sm",
												children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
													className: "font-semibold text-stone-700",
													children: label
												}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
													readOnly: true,
													className: "rounded-md border border-stone-300 bg-stone-50 px-3 py-2",
													value
												})]
											}, label))
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
											className: "overflow-x-auto rounded-md border border-stone-200",
											children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("table", {
												className: "w-full min-w-[760px] border-collapse text-left text-xs",
												children: [
													/* @__PURE__ */ (0, import_jsx_runtime.jsx)("thead", {
														className: "bg-stone-100 text-stone-600",
														children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
															/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
																className: "px-3 py-2",
																children: "G/L account"
															}),
															/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
																className: "px-3 py-2",
																children: "Description"
															}),
															/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
																className: "px-3 py-2",
																children: "From / To"
															}),
															/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
																className: "px-3 py-2",
																children: "Cost"
															}),
															/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
																className: "px-3 py-2",
																children: "VAT"
															}),
															/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
																className: "px-3 py-2 text-right",
																children: "Amount"
															})
														] })
													}),
													/* @__PURE__ */ (0, import_jsx_runtime.jsx)("tbody", { children: selectedPurchaseJournal.lines.map((line) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", {
														className: "border-t border-stone-200",
														children: [
															/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("td", {
																className: "px-3 py-2",
																children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
																	className: "font-semibold",
																	children: line.glAccount
																}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
																	className: "text-stone-500",
																	children: line.glAccountName
																})]
															}),
															/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
																className: "px-3 py-2",
																children: line.description
															}),
															/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("td", {
																className: "px-3 py-2",
																children: [
																	line.from || "-",
																	" / ",
																	line.to || "-",
																	line.accrualReason ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
																		className: "mt-1 text-stone-500",
																		children: line.accrualReason
																	}) : null
																]
															}),
															/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("td", {
																className: "px-3 py-2",
																children: [
																	line.costCentre || "-",
																	" / ",
																	line.costUnit || "-"
																]
															}),
															/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("td", {
																className: "px-3 py-2",
																children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
																	className: "font-semibold",
																	children: [
																		line.vatCode,
																		" - ",
																		line.vatCodeName
																	]
																}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
																	className: "text-stone-500",
																	children: percentScore(line.vatConfidence)
																})]
															}),
															/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("td", {
																className: "px-3 py-2 text-right",
																children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: line.amount.toFixed(2) }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
																	className: "text-stone-500",
																	children: ["VAT ", line.vatAmount.toFixed(2)]
																})]
															})
														]
													}, line.id)) }),
													/* @__PURE__ */ (0, import_jsx_runtime.jsx)("tfoot", {
														className: "border-t border-stone-300 bg-stone-50 font-semibold",
														children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
															className: "px-3 py-2",
															colSpan: 5,
															children: "Difference"
														}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
															className: "px-3 py-2 text-right",
															children: selectedPurchaseJournal.totals.difference.toFixed(2)
														})] })
													})
												]
											})
										})
									]
								}) : null,
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "grid gap-3 sm:grid-cols-2",
									children: Object.keys(fieldLabels).map((field) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
										className: "flex flex-col gap-1 text-sm",
										children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
											className: "font-semibold text-stone-700",
											children: fieldLabels[field]
										}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
											className: "rounded-md border border-stone-300 px-3 py-2 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-500",
											type: field.includes("Date") ? "date" : field.includes("Amount") ? "number" : "text",
											step: field.includes("Amount") ? "0.01" : void 0,
											value: field.includes("Amount") ? numberValue(draft[field]) : String(draft[field] ?? ""),
											onChange: (event) => updateDraft(field, event.target.value),
											disabled: !hasPermission("edit")
										})]
									}, field))
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "rounded-lg border border-stone-200 p-3",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", {
										className: "text-sm font-semibold",
										children: "Line items"
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										className: "mt-2 space-y-2 text-sm",
										children: selectedInvoice.extractedData.lineItems.length ? selectedInvoice.extractedData.lineItems.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
											className: "grid grid-cols-[1fr_auto] gap-3 border-t border-stone-200 pt-2",
											children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: item.description }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: item.netAmount.toFixed(2) })]
										}, item.id)) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
											className: "text-stone-500",
											children: "No line items detected."
										})
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "rounded-lg border border-stone-200 p-3",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
										className: "flex items-center justify-between gap-3",
										children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", {
											className: "text-sm font-semibold",
											children: "Processing timeline"
										}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
											className: "text-xs text-stone-500",
											children: [auditEvents.length, " event(s)"]
										})]
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										className: "mt-3 space-y-3 text-sm",
										children: auditEvents.length ? auditEvents.map((event) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
											className: "border-l-2 border-emerald-600 pl-3",
											children: [
												/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
													className: "font-semibold text-stone-800",
													children: event.message
												}),
												/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
													className: "mt-1 text-xs text-stone-500",
													children: [
														event.userName,
														" - ",
														formatTimestamp(event.createdAt),
														event.field ? ` - ${event.field}` : ""
													]
												}),
												event.field ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
													className: "mt-1 text-xs text-stone-600",
													children: [
														String(event.oldValue ?? "-"),
														" ",
														"->",
														" ",
														String(event.newValue ?? "-")
													]
												}) : null
											]
										}, event.id)) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
											className: "text-stone-500",
											children: "No audit events recorded yet."
										})
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "flex flex-wrap gap-2",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
										onClick: saveDraft,
										loading: busy === "save",
										feedback: buttonFeedbackFor("save", "save"),
										disabled: busy === "save" || !hasUnsavedChanges || !hasPermission("edit"),
										disabledReason: !hasPermission("edit") ? "Your role does not allow editing invoices." : "There are no unsaved review changes.",
										children: "Save changes"
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ActionButton, {
										variant: "outline",
										onClick: () => bookInvoice(selectedInvoice.id),
										loading: busy === `book-${selectedInvoice.id}`,
										feedback: buttonFeedbackFor(`book-${selectedInvoice.id}`, `book-${selectedInvoice.id}`),
										disabled: selectedInvoice.status !== "Ready to Book" || !hasPermission("book") || !state.exactConnection || !state.exactMasterData || state.exactMasterDataStale || busy === `book-${selectedInvoice.id}`,
										disabledReason: bookDisabledReason(selectedInvoice),
										children: "Book invoice"
									})]
								}),
								selectedInvoice.lastError ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
									className: "text-sm text-rose-700",
									children: selectedInvoice.lastError
								}) : null
							]
						})]
					})]
				}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("section", {
					className: "rounded-lg border border-stone-300 bg-white p-4 text-sm text-stone-500",
					children: "No invoice selected."
				}),
				state.outlookLogs.length ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
					className: "rounded-lg border border-stone-300 bg-white p-4",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
						className: "text-lg font-semibold",
						children: "Outlook processing log"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "mt-3 grid gap-2 md:grid-cols-2",
						children: state.outlookLogs.slice(0, 4).map((log) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "rounded-lg border border-stone-200 px-3 py-2 text-sm",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								className: "font-semibold",
								children: log.subject
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "mt-1 text-stone-500",
								children: [
									log.sender,
									" - ",
									log.category
								]
							})]
						}, log.id))
					})]
				}) : null
			]
		})
	});
}
//#endregion
export { IntoWorkbench };
