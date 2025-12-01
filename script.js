// Memorial Video AI - Internal QA Review Gallery
// https://internalreview.memorialvideo.ai/
// Handles photo review, reordering, and links to existing approve/reject/pause/extend endpoints

// === CONFIGURATION ===
const S3_BUCKET = 'order-by-age-uploads';
const S3_BASE_URL = `https://${S3_BUCKET}.s3.amazonaws.com`;

// Lambda endpoint for saving order
const SAVE_ORDER_LAMBDA_URL = 'https://cewpk2fgheclulpkx2fhfywnym0ucucx.lambda-url.us-east-2.on.aws/';

// Existing API Gateway base URL for review actions (approve, reject, pause, extend)
const API_BASE_URL = 'https://w8i78lu05m.execute-api.us-east-2.amazonaws.com/prod';

// === STATE ===
let photoOrder = [];        // Current order of S3 keys
let originalOrder = [];     // Original order (to detect changes)
let uid = null;
let reviewToken = null;
let hasUnsavedChanges = false;

// === INITIALIZATION ===
window.addEventListener('DOMContentLoaded', async () => {
    // Get UID and token from URL
    const urlParams = new URLSearchParams(window.location.search);
    uid = urlParams.get('uid');
    reviewToken = urlParams.get('token');

    // Update display
    document.getElementById('orderUid').textContent = uid || '---';

    if (!uid || !reviewToken) {
        showError('Invalid review link', 'Missing order ID or review token. Please use the link from your email.');
        return;
    }

    console.log(`[INIT] Loading review for UID: ${uid}`);

    try {
        await loadPhotos();
    } catch (error) {
        console.error('[ERROR] Failed to load photos:', error);
        showError('Failed to load photos', error.message);
    }

    // Warn before leaving with unsaved changes
    window.addEventListener('beforeunload', (e) => {
        if (hasUnsavedChanges) {
            e.preventDefault();
            e.returnValue = '';
        }
    });
});

// === LOAD PHOTOS ===
async function loadPhotos() {
    showLoading(true);

    // First check if there's already a custom order saved
    let existingOrder = await loadExistingOrder();

    if (existingOrder) {
        // Use existing custom order
        console.log(`[CUSTOM ORDER] Found existing order with ${existingOrder.length} photos`);
        photoOrder = existingOrder;
    } else {
        // Load from manifest and sort alphabetically
        const manifestUrl = `${S3_BASE_URL}/metadata/${uid}/final_filenames.json`;
        console.log(`[FETCH] Loading manifest from: ${manifestUrl}`);

        const response = await fetch(manifestUrl);

        if (!response.ok) {
            throw new Error(`Failed to fetch manifest: ${response.status}`);
        }

        const manifest = await response.json();
        console.log(`[MANIFEST] Loaded ${manifest.length} entries`);

        // Extract and sort by filename
        const photoEntries = manifest
            .filter(entry => entry.final_key && !entry.final_key.endsWith('.ready'))
            .map(entry => entry.final_key)
            .sort((a, b) => {
                const fileA = a.split('/').pop();
                const fileB = b.split('/').pop();
                return fileA.localeCompare(fileB);
            });

        photoOrder = photoEntries;
        console.log(`[PHOTOS] Sorted ${photoOrder.length} photos`);
    }

    // Store original order for change detection
    originalOrder = [...photoOrder];

    // Render gallery
    renderGallery();

    // Initialize drag-and-drop
    initializeSortable();

    // Update UI
    document.getElementById('photoCount').textContent = photoOrder.length;
    document.getElementById('saveOrderBtn').disabled = true;

    // Show bottom actions if many photos
    if (photoOrder.length > 20) {
        document.getElementById('bottomActions').style.display = 'flex';
    }

    showLoading(false);
}

// === LOAD EXISTING CUSTOM ORDER ===
async function loadExistingOrder() {
    try {
        const customOrderUrl = `${S3_BASE_URL}/metadata/${uid}/custom_order.json`;
        const response = await fetch(customOrderUrl);
        
        if (response.ok) {
            const data = await response.json();
            console.log(`[CUSTOM ORDER] Found order from ${data.updated_at}`);
            return data.order;
        }
    } catch (e) {
        console.log('[CUSTOM ORDER] No existing order found');
    }
    return null;
}

// === RENDER GALLERY ===
function renderGallery() {
    const gallery = document.getElementById('photoGallery');
    gallery.innerHTML = '';

    photoOrder.forEach((s3Key, index) => {
        const filename = s3Key.split('/').pop();
        const ageBucket = extractAgeBucket(filename);

        const photoItem = document.createElement('div');
        photoItem.className = 'photo-item loading';
        photoItem.dataset.s3Key = s3Key;
        photoItem.dataset.index = index;

        const displayNum = String(index + 1).padStart(3, '0');

        photoItem.innerHTML = `
            <div class="photo-number">${displayNum}</div>
            <div class="age-bucket">${ageBucket}</div>
            <img src="${S3_BASE_URL}/${s3Key}" 
                 alt="Photo ${index + 1}" 
                 loading="lazy"
                 onload="this.parentElement.classList.remove('loading')"
                 onerror="handleImageError(this)">
        `;

        gallery.appendChild(photoItem);
    });

    document.querySelector('.gallery-container').style.display = 'block';
}

// === EXTRACT AGE BUCKET FROM FILENAME ===
function extractAgeBucket(filename) {
    // Filename: 01-05(003)_|EX|_originalname.jpg
    // Extract: 01-05
    const match = filename.match(/^(\d{2}-\d{2})/);
    return match ? match[1] : '??';
}

// === HANDLE IMAGE ERROR ===
function handleImageError(img) {
    console.error('[IMAGE ERROR]', img.src);
    img.parentElement.classList.remove('loading');
    img.src = 'data:image/svg+xml,' + encodeURIComponent(`
        <svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150">
            <rect fill="#2d3748" width="150" height="150"/>
            <text x="50%" y="50%" text-anchor="middle" dy=".3em" fill="#a0aec0" font-family="sans-serif" font-size="12">
                Load failed
            </text>
        </svg>
    `);
}

// === INITIALIZE SORTABLE ===
function initializeSortable() {
    const gallery = document.getElementById('photoGallery');

    new Sortable(gallery, {
        animation: 150,
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        dragClass: 'sortable-drag',
        
        onEnd: function(evt) {
            if (evt.oldIndex !== evt.newIndex) {
                // Update photoOrder array
                const [movedItem] = photoOrder.splice(evt.oldIndex, 1);
                photoOrder.splice(evt.newIndex, 0, movedItem);

                // Update display numbers
                updateDisplayNumbers();

                // Mark as changed
                markAsChanged();

                console.log(`[REORDER] Moved from ${evt.oldIndex + 1} to ${evt.newIndex + 1}`);
            }
        }
    });

    console.log('[SORTABLE] Initialized');
}

// === UPDATE DISPLAY NUMBERS ===
function updateDisplayNumbers() {
    const items = document.querySelectorAll('.photo-item');
    items.forEach((item, index) => {
        const badge = item.querySelector('.photo-number');
        if (badge) {
            badge.textContent = String(index + 1).padStart(3, '0');
        }
        item.dataset.index = index;
    });
}

// === MARK AS CHANGED ===
function markAsChanged() {
    hasUnsavedChanges = true;
    document.getElementById('saveOrderBtn').disabled = false;
    document.getElementById('saveStatus').textContent = 'Unsaved changes';
    document.getElementById('saveStatus').className = 'save-status';
}

// === SAVE ORDER ===
async function saveOrder() {
    const saveBtn = document.getElementById('saveOrderBtn');
    const saveStatus = document.getElementById('saveStatus');
    
    saveBtn.disabled = true;
    saveStatus.textContent = 'Saving...';
    saveStatus.className = 'save-status saving';

    try {
        const response = await fetch(SAVE_ORDER_LAMBDA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                uid: uid,
                review_token: reviewToken,
                photo_order: photoOrder
            })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || `Server error: ${response.status}`);
        }

        const result = await response.json();
        console.log('[SAVE] Success:', result);

        // Update state
        hasUnsavedChanges = false;
        originalOrder = [...photoOrder];
        
        saveStatus.textContent = 'Saved ✓';
        saveStatus.className = 'save-status saved';

        // Clear status after 3 seconds
        setTimeout(() => {
            if (saveStatus.textContent === 'Saved ✓') {
                saveStatus.textContent = '';
            }
        }, 3000);

    } catch (error) {
        console.error('[SAVE ERROR]', error);
        saveStatus.textContent = 'Save failed!';
        saveStatus.className = 'save-status error';
        saveBtn.disabled = false;
        
        alert(`Failed to save order: ${error.message}`);
    }
}

// === APPROVE ORDER ===
// Uses existing API Gateway endpoint - navigates to the URL
async function approveOrder() {
    // Check for unsaved changes
    if (hasUnsavedChanges) {
        const save = confirm('You have unsaved changes. Save them before approving?');
        if (save) {
            await saveOrder();
            // Wait a moment for save to complete
            await new Promise(r => setTimeout(r, 500));
        }
    }

    const confirmed = confirm('Approve this order and send to customer now?');
    if (!confirmed) return;

    // Navigate to existing approve endpoint
    window.location.href = `${API_BASE_URL}/approve/${reviewToken}`;
}

// === REJECT ORDER ===
// Uses existing API Gateway endpoint - navigates to the URL
function rejectOrder() {
    if (hasUnsavedChanges) {
        const discard = confirm('You have unsaved changes. Discard them and reject?');
        if (!discard) return;
    }

    const confirmed = confirm('Reject this order? The customer will NOT receive their photos.');
    if (!confirmed) return;

    // Navigate to existing reject endpoint
    window.location.href = `${API_BASE_URL}/reject/${reviewToken}`;
}

// === PAUSE TIMER ===
function pauseTimer() {
    window.location.href = `${API_BASE_URL}/pause/${reviewToken}`;
}

// === EXTEND TIMER ===
function extendTimer(minutes) {
    window.location.href = `${API_BASE_URL}/extend/${reviewToken}?minutes=${minutes}`;
}

// === UI HELPERS ===
function showLoading(show) {
    document.getElementById('loadingState').style.display = show ? 'block' : 'none';
    if (show) {
        document.querySelector('.gallery-container').style.display = 'none';
    }
}

function showError(title, detail = '') {
    document.getElementById('loadingState').style.display = 'none';
    document.querySelector('.gallery-container').style.display = 'none';
    document.querySelector('.action-bar').style.display = 'none';
    document.querySelector('.instructions').style.display = 'none';
    
    const errorState = document.getElementById('errorState');
    errorState.style.display = 'block';
    errorState.querySelector('h2').textContent = title;
    
    if (detail) {
        document.getElementById('errorDetail').textContent = detail;
    }
}
