terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
}

// 1. Create BigQuery Dataset
resource "google_bigquery_dataset" "profiler_dataset" {
  dataset_id                 = var.dataset_id
  project                    = var.gcp_project_id
  location                   = var.gcp_region
  friendly_name              = "Profiler Denormalized Data Dataset"
  description                = "Dataset to store denormalized Cloud Profiler data."
  delete_contents_on_destroy = false
}

// 2. Create Table for Denormalized Profile Data
resource "google_bigquery_table" "profiler_denormalized_table" {
  project    = var.gcp_project_id
  dataset_id = google_bigquery_dataset.profiler_dataset.dataset_id
  table_id   = var.denormalized_table_id

  description = "Stores fully denormalized profile data uploaded directly by the agent."
  schema      = file("${path.module}/profiler_denormalized_schema.json") // Ensure this file exists and matches your schema

  dynamic "time_partitioning" {
    for_each = var.denormalized_table_partition_expiration_days > 0 ? [1] : []
    content {
      type          = "DAY"
      field         = "upload_timestamp" // This field must exist in your schema with TIMESTAMP or DATE type
      expiration_ms = var.denormalized_table_partition_expiration_days * 24 * 60 * 60 * 1000
    }
  }
  deletion_protection = false
}

// 3. Create the Aggregation UDF
resource "google_bigquery_routine" "aggregation_udf" {
  project         = var.gcp_project_id
  dataset_id      = google_bigquery_dataset.profiler_dataset.dataset_id
  routine_id      = var.udf_name
  routine_type    = "SCALAR_FUNCTION"
  language        = "JAVASCRIPT"
  definition_body = file("${path.module}/buildAggregatedFlameGraphJson.js") // Ensure this file exists

  arguments {
    name = "aggregated_profiles"
    data_type = jsonencode({
      "typeKind" = "ARRAY",
      "arrayElementType" = {
        "typeKind" = "STRUCT",
        "structType" = {
          "fields" = [
            // --- sample ---
            {
              "name" = "sample",
              "type" = {
                "typeKind" = "ARRAY",
                "arrayElementType" = {
                  "typeKind" = "STRUCT",
                  "structType" = {
                    "fields" = [
                      { "name" = "location_id", "type" = { "typeKind" = "ARRAY", "arrayElementType" = { "typeKind" = "INT64" } } },
                      { "name" = "value", "type" = { "typeKind" = "ARRAY", "arrayElementType" = { "typeKind" = "INT64" } } },
                      {
                        "name" = "label",
                        "type" = {
                          "typeKind" = "ARRAY",
                          "arrayElementType" = {
                            "typeKind" = "STRUCT",
                            "structType" = {
                              "fields" = [
                                { "name" = "key", "type" = { "typeKind" = "STRING" } },
                                { "name" = "str", "type" = { "typeKind" = "STRING" } },
                                { "name" = "num", "type" = { "typeKind" = "INT64" } },
                                { "name" = "num_unit", "type" = { "typeKind" = "STRING" } }
                              ]
                            }
                          }
                        }
                      }
                    ]
                  }
                }
              }
            },
            // --- location ---
            {
              "name" = "location",
              "type" = {
                "typeKind" = "ARRAY",
                "arrayElementType" = {
                  "typeKind" = "STRUCT",
                  "structType" = {
                    "fields" = [
                      { "name" = "id", "type" = { "typeKind" = "INT64" } },
                      { "name" = "mapping_id", "type" = { "typeKind" = "INT64" } },
                      { "name" = "address", "type" = { "typeKind" = "INT64" } },
                      {
                        "name" = "line",
                        "type" = {
                          "typeKind" = "ARRAY",
                          "arrayElementType" = {
                            "typeKind" = "STRUCT",
                            "structType" = {
                              "fields" = [
                                { "name" = "function_id", "type" = { "typeKind" = "INT64" } },
                                { "name" = "line", "type" = { "typeKind" = "INT64" } },
                                { "name" = "column", "type" = { "typeKind" = "INT64" } }
                              ]
                            }
                          }
                        }
                      },
                      { "name" = "is_folded", "type" = { "typeKind" = "BOOL" } }
                    ]
                  }
                }
              }
            },
            // --- function ---
            {
              "name" = "function",
              "type" = {
                "typeKind" = "ARRAY",
                "arrayElementType" = {
                  "typeKind" = "STRUCT",
                  "structType" = {
                    "fields" = [
                      { "name" = "id", "type" = { "typeKind" = "INT64" } },
                      { "name" = "name", "type" = { "typeKind" = "STRING" } },
                      { "name" = "system_name", "type" = { "typeKind" = "STRING" } },
                      { "name" = "filename", "type" = { "typeKind" = "STRING" } },
                      { "name" = "start_line", "type" = { "typeKind" = "INT64" } }
                    ]
                  }
                }
              }
            },
            // --- sample_type ---
            {
              "name" = "sample_type",
              "type" = {
                "typeKind" = "ARRAY",
                "arrayElementType" = {
                  "typeKind" = "STRUCT",
                  "structType" = {
                    "fields" = [
                      { "name" = "type", "type" = { "typeKind" = "STRING" } },
                      { "name" = "unit", "type" = { "typeKind" = "STRING" } }
                    ]
                  }
                }
              }
            }
          ]
        }
      }
    })
  }

  arguments {
    name      = "num_profiles"
    data_type = jsonencode({ "typeKind" = "INT64" })
  }
  // arguments { // Uncomment if your UDF accepts intended_limit
  //   name      = "intended_limit"
  //   data_type = jsonencode({"typeKind" = "INT64"})
  // }

  return_type = jsonencode({ "typeKind" = "STRING" })
}
