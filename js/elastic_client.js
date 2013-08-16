function getClusterState(host) {
	var cluster_state = syncRequest('GET',host+"/_cluster/state", {}).response;
	var cluster_status = syncRequest('GET',host+"/_status", {}).response;
	var nodes_stats = syncRequest('GET',host+"/_cluster/nodes/stats?all=true", {}).response;
	var cluster_health = syncRequest('GET',host+"/_cluster/health", {}).response;
	var settings = syncRequest('GET',host+"/_cluster/settings", {}).response;
	return new Cluster(cluster_state,cluster_status,nodes_stats,cluster_health,settings);
}
function flipDisableShardAllocation(host,current_state) {
	var new_state = current_state == true ? "false" : "true";
	var new_settings = {"transient":{ "cluster.routing.allocation.disable_allocation":new_state	}};
	return syncRequest('PUT', host + "/_cluster/settings",JSON.stringify(new_settings, undefined, ""));
}

function ServerResponse(success, response) {
	this.success = success;
	this.response = response;
}

function openIndex(host,index) {
	return syncRequest('POST', host + "/" + index + "/_open", {});
}

function setReplicas(host,index,replicas) {
	return syncRequest('PUT', host + "/" + index + "/_settings", {"number_of_replicas":replicas});
}

function optimizeIndex(host,index) {
	return syncRequest('POST',host + "/" + index + "/_optimize", {});
}

function clearCache(host,index) {
	return syncRequest('POST',host + "/" + index + "/_cache/clear", {});
}

function closeIndex(host,index) {
	return syncRequest('POST', host + "/" + index + "/_close", {});	
}

function refreshIndex(host,index) {
	return syncRequest('POST', host + "/" + index + "/_refresh", {});	
}
function createIndex(host, name, settings) {
	return syncRequest('PUT', host + "/" + name, settings);	
}

function deleteIndex(host, name) {
	return syncRequest('DELETE', host + "/" + name);	
}

function updateIndexSettings(host, name, settings) {
	return syncRequest('PUT', host + "/" + name + "/_settings", settings);	
}

// Cluster Object. Contains all the information about the cluster
function Cluster(state,status,nodes,health,settings) {
	// cluster health
	this.status = health['status'];
	this.timed_out = health['timed_out'];
	this.number_of_nodes = health['number_of_nodes'];
	this.number_of_data_nodes = health['number_of_data_nodes'];
	this.active_primary_shards = health['active_primary_shards'];
	this.active_shards = health['active_shards'];
	this.relocating_shards = health['relocating_shards'];
	this.initializing_shards = health['initializing_shards'];
	this.unassigned_shards = health['unassigned_shards'];
	this.disableAllocation = "false";
	if (typeof settings['persistent'] != undefined && typeof settings['persistent']['disable_allocation'] != undefined) {
		this.disableAllocation = settings['persistent']['disable_allocation'];
	}
	if (typeof settings['transient'] != undefined && typeof settings['transient']['cluster.routing.allocation.disable_allocation'] != undefined) {
		this.disableAllocation = settings['transient']['cluster.routing.allocation.disable_allocation'] === "true" ? "true" : "false";
	}
	this.name = state['cluster_name'];
	this.master_node = state['master_node'];
	this.nodes = Object.keys(state['nodes']).map(function(x) { 
		var node = new Node(x,state['nodes'][x],nodes['nodes'][x]);
		if (node.id === state['master_node']) {
			node.setCurrentMaster();
		}
		return node;
	}).sort(compareNodes);

	var iMetadata = state['metadata']['indices'];
	var iRoutingTable = state['routing_table']['indices'];
	var iStatus = status['indices'];
	var count = 0;
	var unassigned_shards = 0;
	var total_size = 0;
	this.indices = Object.keys(iMetadata).map(
		function(x) { 
			var index = new Index(x,iRoutingTable[x], iMetadata[x], iStatus[x]);
			unassigned_shards += index.unassigned.length;
			total_size += parseInt(index.total_size);
			return index;
		 }
	).sort(compareIndices);
	this.unassigned_shards = unassigned_shards;
	this.total_indices = this.indices.length;
	this.shards = status['_shards']['total'];
	this.failed_shards = status['_shards']['failed'];
	this.successful_shards = status['_shards']['successful'];
	this.total_size = total_size;
	this.getNodes=function(data, master, client) { 
		return $.map(this.nodes,function(n) { 
			return (data && n.data || master && n.master || client && n.client) ? n : null;
		});
	};
}

// Represents an ElasticSearch node
function Node(node_id, node_info, node_stats) {
	this.id = node_id;	
	this.name = node_info['name'];
	this.transport_address = node_info['transport_address'];
	var master = node_info['attributes']['master'] === 'false' ? false : true;
	var data = node_info['attributes']['data'] === 'false' ? false : true;
	var client = node_info['attributes']['client'] === 'true' ? true : false;
	this.master =  master && !client;
	this.data = data && !client;
	this.client = client || !master && !data;
	this.current_master = false;
	this.stats = node_stats;
	console.log(node_stats);
	this.setCurrentMaster=function() {
		this.current_master = true;
	}
}

function Index(index_name,index_info, index_metadata, index_status) {
	this.name = index_name;
	var index_shards = {};
	this.shards = index_shards;
	this.state = index_metadata['state'];
	this.aliases = index_metadata['aliases'];
	this.settings = index_metadata['settings'];
	this.mappings = JSON.stringify(index_metadata['mappings'], undefined, "\t");
	this.num_of_shards = index_metadata['settings']['index.number_of_shards'];
	this.num_of_replicas = index_metadata['settings']['index.number_of_replicas'];
	this.state_class = index_metadata['state'] === "open" ? "success" : "active";
	this.visible = true;
	var unassigned = [];

	// adds shard information
	if (typeof index_status != 'undefined') {
		$.map(index_status.shards, function(shards, shard_num) {
			$.map(shards, function(shard_info, shard_copy) {
				if (typeof index_shards[shard_info.routing.node] === 'undefined') {
					index_shards[shard_info.routing.node] = [];
				}
				index_shards[shard_info.routing.node].push(new Shard(shard_info));
			});
		});
	}
	// adds unassigned shards information
	if (index_info) {
  		Object.keys(index_info['shards']).forEach(function(x) { 
  			var shards_info = index_info['shards'][x];
			shards_info.forEach(function(shard_info) {
				if (shard_info['state'] === 'UNASSIGNED') {
					unassigned.push(shard_info['shard']);	
				}
			});
  		});
	}


	this.unassigned = unassigned;
	var has_status = this.state === 'open' && (typeof index_status != 'undefined')
	this.num_docs = has_status ? index_status['docs']['num_docs'] : 0;
	this.max_doc = has_status ? index_status['docs']['max_doc'] : 0;
	this.deleted_docs = has_status ? index_status['docs']['deleted_docs'] : 0;
	this.size = has_status ? index_status['index']['primary_size_in_bytes'] : 0;
	this.total_size = has_status ? index_status['index']['size_in_bytes'] : 0;
	this.settingsAsString=function() {
		return JSON.stringify(this.settings, undefined, "  ");
	}
}

function Shard(shard_info) {
	this.info = shard_info;
	this.primary = shard_info.routing.primary;
	this.shard = shard_info.routing.shard;
	this.state = shard_info.routing.state;
	this.node = shard_info.routing.node;
	this.index = shard_info.routing.index;
	this.id = this.node + "_" + this.shard + "_" + this.index;
}

// TODO: take into account node specs
function compareNodes(a,b) {
	if (b.current_master) {
		return 1;
	}
	if (a.current_master) {
		return -1;
	}
	if (b.master && !a.master) {
		return 1;
	} 
	if (a.master && !b.master) {
		return -1;
	}
	
	if (b.data && !a.data) {
		return 1;
	} 
	if (a.data && !b.data) {
		return -1;
	}
	
	return a.name.localeCompare(b.name);
}

// TODO: take into account index properties
function compareIndices(a,b) {
	return a.name.localeCompare(b.name);
}

function syncRequest(method, url, data) {
	var response;
	$.ajax({
	    type: method,
	    url: url,
	    dataType: 'json',
	    success: function(r) { response = new ServerResponse(true,r) },
		error: function(r) { response = new ServerResponse(false,r) },
	    data: data,
	    async: false
	});
	return response;
}