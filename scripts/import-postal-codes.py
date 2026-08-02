#!/usr/bin/env python3
"""
Import GeoNames postal code data into Supabase postal_codes table.

Usage:
  1. Download allCountries.zip from http://download.geonames.org/export/zip/
  2. Unzip to get allCountries.txt
  3. Run: python3 import-postal-codes.py [--file allCountries.txt] [--batch 5000]

Environment:
  SUPABASE_URL  - e.g. http://192.168.0.5:8000
  SUPABASE_SERVICE_KEY - service_role JWT

GeoNames TSV format (tab-separated, no header):
  0: country code (iso2)
  1: postal code
  2: place name
  3: admin name1 (state)
  4: admin code1
  5: admin name2 (county)
  6: admin code2
  7: admin name3 (community)
  8: admin code3
  9: latitude
  10: longitude
  11: accuracy
"""

import os
import sys
import json
import urllib.request
import urllib.error
import argparse
import zipfile
import io

SUPABASE_URL = os.environ.get('SUPABASE_URL', 'http://192.168.0.5:8000')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')

def import_batch(rows: list[dict]) -> bool:
    """Insert a batch of rows via PostgREST."""
    url = f"{SUPABASE_URL}/rest/v1/postal_codes"
    data = json.dumps(rows).encode('utf-8')
    req = urllib.request.Request(url, data=data, method='POST')
    req.add_header('apikey', SUPABASE_KEY)
    req.add_header('Authorization', f'Bearer {SUPABASE_KEY}')
    req.add_header('Content-Type', 'application/json')
    req.add_header('Prefer', 'resolution=ignore-duplicates')
    try:
        urllib.request.urlopen(req)
        return True
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"  ERROR {e.code}: {body[:200]}")
        return False

def parse_line(line: str) -> dict | None:
    """Parse a single GeoNames TSV line."""
    parts = line.strip().split('\t')
    if len(parts) < 10:
        return None
    
    country_code = parts[0].strip()
    postal_code = parts[1].strip()
    place_name = parts[2].strip()
    
    if not country_code or not postal_code or not place_name:
        return None
    if len(country_code) != 2:
        return None
    
    row = {
        'country_code': country_code,
        'postal_code': postal_code,
        'place_name': place_name,
        'state_name': parts[3].strip() or None,
        'state_code': parts[4].strip() or None,
        'county_name': parts[5].strip() or None,
    }
    
    try:
        row['latitude'] = float(parts[9]) if parts[9].strip() else None
        row['longitude'] = float(parts[10]) if parts[10].strip() else None
    except (ValueError, IndexError):
        row['latitude'] = None
        row['longitude'] = None
    
    return row

def download_geonames(dest_path: str):
    """Download allCountries.zip from GeoNames and extract."""
    url = 'http://download.geonames.org/export/zip/allCountries.zip'
    print(f"Downloading {url} ...")
    urllib.request.urlretrieve(url, dest_path + '.zip')
    print("Extracting...")
    with zipfile.ZipFile(dest_path + '.zip', 'r') as zf:
        # Find the main txt file
        for name in zf.namelist():
            if name.endswith('.txt') and 'readme' not in name.lower():
                with zf.open(name) as src, open(dest_path, 'wb') as dst:
                    dst.write(src.read())
                print(f"Extracted: {name} -> {dest_path}")
                return
    raise RuntimeError("No .txt file found in ZIP")

def main():
    parser = argparse.ArgumentParser(description='Import GeoNames postal codes')
    parser.add_argument('--file', default='allCountries.txt', help='Path to allCountries.txt')
    parser.add_argument('--batch', type=int, default=5000, help='Batch size for inserts')
    parser.add_argument('--download', action='store_true', help='Download allCountries.zip first')
    parser.add_argument('--country', default='', help='Import only specific country (e.g. US)')
    args = parser.parse_args()
    
    if not SUPABASE_KEY:
        print("ERROR: Set SUPABASE_SERVICE_KEY environment variable")
        sys.exit(1)
    
    if args.download or not os.path.exists(args.file):
        download_geonames(args.file)
    
    print(f"Reading {args.file} ...")
    batch = []
    total = 0
    errors = 0
    
    with open(args.file, 'r', encoding='utf-8') as f:
        for line in f:
            row = parse_line(line)
            if not row:
                continue
            if args.country and row['country_code'] != args.country.upper():
                continue
            
            batch.append(row)
            
            if len(batch) >= args.batch:
                if import_batch(batch):
                    total += len(batch)
                    print(f"  Imported {total} rows...")
                else:
                    errors += 1
                batch = []
    
    # Final batch
    if batch:
        if import_batch(batch):
            total += len(batch)
        else:
            errors += 1
    
    print(f"\nDone! Total imported: {total} rows, Errors: {errors} batches")

if __name__ == '__main__':
    main()
