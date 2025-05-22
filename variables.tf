variable "gcp_project_id" {
  description = "The GCP Project ID where BigQuery resources will be created."
  type        = string
  // User must provide this.
}

variable "gcp_region" {
  description = "The GCP region for the BigQuery dataset (e.g., 'US', 'europe-west1')."
  type        = string
  default     = "US"
}

variable "dataset_id" {
  description = "The ID for the BigQuery dataset to be created."
  type        = string
  default     = "profiler_data" // Default dataset name
}

variable "denormalized_table_id" {
  description = "The ID for the BigQuery table storing denormalized profile data."
  type        = string
  default     = "profiler_denormalized_data" // Default table name
}

variable "denormalized_table_partition_expiration_days" {
  description = "Number of days to keep partitions in the denormalized table. Set to 0 or null for no expiration."
  type        = number
  default     = 0 // Default to no expiration, user can override for cost management
}

variable "udf_name" {
  description = "The name for the BigQuery UDF."
  type        = string
  default     = "buildAggregatedFlameGraphJson"
}
