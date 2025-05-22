// --- Helper Functions ---

// Builds combined lookup maps (primarily for potential use, main loop uses per-profile maps)
function buildLookupMaps(aggregated_profiles) {
	const locationMap = new Map();
	const functionMap = new Map();
	(aggregated_profiles || []).forEach(profile => {
			(profile.location || []).forEach(loc => { if (loc && loc.id != null) locationMap.set(loc.id, loc); });
			(profile.function || []).forEach(fn => { if (fn && fn.id != null) functionMap.set(fn.id, fn); });
	});
	return { locationMap, functionMap };
}

// Generates a frame name for a location ID using the provided lookup maps.
// *** MODIFIED: Excludes line numbers to merge identical function calls in the same file. ***
function getFrameName(locId, locationMap, functionMap) {
	const location = locationMap.get(locId);
	let frameName = `[unknown_location:${locId}]`;
	if (location) {
			const lineInfo = location.line && location.line.length > 0 ? location.line[0] : null;
			if (lineInfo && lineInfo.function_id != null) {
					const func = functionMap.get(lineInfo.function_id);
					if (func) {
							const displayFuncName = func.name || func.system_name || `[fid:${lineInfo.function_id}]`;
							const fileName = func.filename || '';
							// Exclude line number from name: Format is 'func (file)' or just 'func'
							frameName = fileName ? `${displayFuncName} (${fileName})` : `${displayFuncName}`;
					} else {
							frameName = `[unknown_function:${lineInfo.function_id}]`;
					}
			} else if (location.address != null) {
					frameName = `[addr:0x${(location.address || 0).toString(16)}]`;
			}
	}
	return frameName.replace(/\s+/g, ' ').trim();
}

// Recursively converts children from object maps to sorted arrays (d3-flame-graph format).
function convertChildrenToArray(node) {
	if (!node || typeof node !== 'object' || !node.children || typeof node.children !== 'object') return;
	const childrenObject = node.children;
	const childrenArray = Object.values(childrenObject);
	childrenArray.sort((a, b) => b.value - a.value); // Sort descending by value
	node.children = childrenArray;
	childrenArray.forEach(convertChildrenToArray);
}

// Helper function for formatting values for display ---
// Note: This is a basic example. A robust solution might need the actual unit
// information passed from the BigQuery UDF more explicitly or use the 'unitStr' later.
function formatDisplayValue(value, unitHint = 'units') {
	if (typeof value !== 'number' || isNaN(value)) {
			return 'N/A';
	}
	// Basic byte formatting example
	unitHint = unitHint.toLowerCase();
	if (unitHint.includes('bytes')) {
			if (value === 0) return '0 Bytes';
			const k = 1024;
			const sizes = ['Bytes', 'KiB', 'MiB', 'GiB', 'TiB'];
			const i = Math.floor(Math.log(value) / Math.log(k));
			if (i < 0 || i >= sizes.length) return parseFloat(value.toFixed(1)) + ' Bytes'; // Fallback for very small/large
			return parseFloat((value / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
	}
	// Basic nanosecond formatting
	if (unitHint.includes('nanoseconds')) {
			if (value < 1000) return value.toFixed(0) + ' ns';
			if (value < 1000000) return (value / 1000).toFixed(1) + ' µs';
			if (value < 1000000000) return (value / 1000000).toFixed(1) + ' ms';
			return (value / 1000000000).toFixed(2) + ' s';
	}
	// Add other unit formatting as needed (e.g., count)
	if (unitHint.includes('count')) {
			 return value.toLocaleString(undefined, {maximumFractionDigits: 0}); // No decimals for count
	}
	// Fallback to generic number formatting with some precision
	return value.toLocaleString(undefined, {minimumFractionDigits: 1, maximumFractionDigits: 1});
}


// Recursive function to update node names with their values ---
function updateNodeNamesWithValueAndPercent(node, unitForFormatting, totalRootValue) {
	if (!node || typeof node !== 'object') return;

	const originalName = node.name || ""; // Should be set before this function is called
	const nodeValue = node.value || 0;
	const formattedValue = formatDisplayValue(nodeValue, unitForFormatting);
	let percentageOfRoot = 0;

	if (totalRootValue > 0) { // Prevent division by zero
			percentageOfRoot = (nodeValue / totalRootValue) * 100;
	} else if (nodeValue === 0 && totalRootValue === 0) { // Handle case where everything is zero
			percentageOfRoot = 0; // Or 100% if it's the root itself and total is 0
	}
	
	// For the root node itself, if its value is the totalRootValue, it's 100%
	if (nodeValue === totalRootValue && totalRootValue !== 0) {
			percentageOfRoot = 100;
	}


	node.name = `${originalName} (${formattedValue}, ${percentageOfRoot.toFixed(1)}%)`;

	if (Array.isArray(node.children)) {
			node.children.forEach(child => updateNodeNamesWithValueAndPercent(child, unitForFormatting, totalRootValue));
	}
}


// --- Main UDF Logic ---
try {
	if (!aggregated_profiles || aggregated_profiles.length === 0 || num_profiles <= 0) {
			const message = num_profiles === 0 ? 'root (no matching profiles found for the selected criteria)' : 'root (invalid input)';
			return JSON.stringify({ name: message, value: 0, children: [] });
	}

	// Determine which value index to use (remains the same logic)
	let valueIndex = 1; // Default for Heap, adjust as needed or make dynamic
	const firstProfileSampleTypes = aggregated_profiles[0].sample_type;
	if (!firstProfileSampleTypes || firstProfileSampleTypes.length === 0) {
			console.error("Error: First profile missing sample_type definition.");
			return JSON.stringify({ name: 'root (Error: Missing sample_type)', value: 0, children: [] });
	}
	if (firstProfileSampleTypes.length === 1) valueIndex = 0;
	else if (valueIndex >= firstProfileSampleTypes.length) {
			console.warn(`Warning: Default value index ${valueIndex} out of bounds. Falling back to 0.`);
			valueIndex = 0;
	}

	// Initialize the root node for the aggregated flame graph
	let aggregatedRoot = { name: 'root', value: 0, children: {}, _totalValue: 0.0 };

	// --- Stage 1: Aggregate the total values for each stack frame ---
	aggregated_profiles.forEach(profile => {
			if (!profile || !profile.sample) return;

			// IMPORTANT: Build lookup maps scoped to the *current* profile being processed
			const currentProfileLocationMap = new Map((profile.location || []).map(loc => [loc.id, loc]));
			const currentProfileFunctionMap = new Map((profile.function || []).map(fn => [fn.id, fn]));

			profile.sample.forEach(sample => {
					const sampleValue = (sample.value && valueIndex < sample.value.length)
							? Number(sample.value[valueIndex]) : 0;

					if (isNaN(sampleValue) || sampleValue === 0) return; // Skip invalid/zero values

					let currentNode = aggregatedRoot;
					aggregatedRoot._totalValue += sampleValue; // Add to overall total

					const locationIds = sample.location_id || [];
					const reversedLocationIds = [...locationIds].reverse(); // Process stack bottom-up

					reversedLocationIds.forEach(locId => {
							const frameName = getFrameName(locId, currentProfileLocationMap, currentProfileFunctionMap);
							if (!currentNode.children[frameName]) {
									currentNode.children[frameName] = {
											name: frameName, value: 0, children: {}, _totalValue: 0.0
									};
							}
							currentNode = currentNode.children[frameName];
							currentNode._totalValue += sampleValue; // Accumulate total value for this frame
					});
			});
	});

	// --- Stage 2: Calculate the average value for each node ---
	function calculateAverages(node, num_profiles_avg) {
			if (!node || typeof node !== 'object' || num_profiles_avg <= 0) return;
			node.value = Math.max(0, node._totalValue / num_profiles_avg);
			if (typeof node.children === 'object' && !Array.isArray(node.children)) {
					Object.values(node.children).forEach(child => calculateAverages(child, num_profiles_avg));
			} else if (Array.isArray(node.children)) {
					node.children.forEach(child => calculateAverages(child, num_profiles_avg));
			}
	}
	calculateAverages(aggregatedRoot, num_profiles); // Use the actual number aggregated

	// --- Stage 3: Finalize structure for d3-flame-graph ---
	const sampleInfo = firstProfileSampleTypes[valueIndex];
	const typeStr = sampleInfo.type || 'Unknown Type';
	const unitStr = sampleInfo.unit || 'Units';
	const profileCountText = num_profiles >= 250 ? `random sample of 250 profiles` : `${num_profiles} profiles`; // Indicate if sampled
	aggregatedRoot.name = `${typeStr} (${unitStr} - averaged over ${profileCountText})`;

	convertChildrenToArray(aggregatedRoot);
	
	const totalRootValueForPercentage = aggregatedRoot.value; // This is the 100% mark
	updateNodeNamesWithValueAndPercent(aggregatedRoot, unitStr, totalRootValueForPercentage);


	if (typeof aggregatedRoot.value !== 'number' || isNaN(aggregatedRoot.value)) {
			console.error("Error: Final root value is not a valid number:", aggregatedRoot.value);
			aggregatedRoot.value = 0; // Fallback
	}

	return JSON.stringify(aggregatedRoot);

} catch (e) {
	console.error("Error in buildAggregatedFlameGraphJson UDF: " + e.message + "\nStack: " + e.stack);
	return JSON.stringify({ name: 'root (Error in UDF)', value: 0, children: [], error: `UDF Error: ${e.message}` });
}
